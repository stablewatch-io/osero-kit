import { type Address, encodeFunctionData } from 'viem';

import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage, usdsFromUsdcViaSellGem } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { errAsync, okAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type { Erc20ApprovalRequired } from '../types.js';

/**
 * Parameters accepted by {@link mintUsds}.
 */
export type MintUsdsRequest = {
  /**
   * The chain on which the mint should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDC to spend, in USDC's native 6 decimals (use
   * `parseUnits(amount, 6)` from viem).
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;

  /**
   * The wallet that will pay the USDC. Used as the `from` address on
   * every transaction in the returned plan.
   */
  readonly sender: Address;

  /**
   * The address that should receive the resulting USDS. Defaults to
   * {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points) applied to the PSM3
   * `previewSwapExactIn` quote when computing `minAmountOut`.
   * Ignored on Ethereum mainnet because the Sky Lite PSM is
   * deterministic.
   *
   * @defaultValue {@link ClientConfig.defaultSlippageBps} (5 bps)
   */
  readonly slippageBps?: number;

  /**
   * Opaque referral code emitted in the PSM3 `Swap` event for
   * off-chain attribution. Ignored on Ethereum mainnet.
   *
   * @defaultValue 0n
   */
  readonly referralCode?: bigint;
};

/**
 * Parameters accepted by {@link previewMintUsds}.
 */
export type PreviewMintUsdsRequest = {
  /**
   * The chain on which the preview should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDC to spend, in USDC's native 6 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;
};

export type MintUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much USDS an exact-in {@link mintUsds} flow would return
 * for the given USDC amount.
 */
export function previewMintUsds(
  client: OseroClient,
  request: PreviewMintUsdsRequest,
): ResultAsync<bigint, MintUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetMintUsds(client, chain, request.amount);
  }

  return quoteL2MintUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that mints USDS from USDC on the
 * target chain. The plan is wallet-agnostic — pass it to
 * {@link sendWith} from `@osero/client/viem` or `@osero/client/ethers`
 * to actually broadcast the transactions.
 *
 * On L2s (Base, Arbitrum One, OP Mainnet, Unichain) the flow is a
 * single approval-then-swap through Spark's PSM3:
 *
 * 1. `USDC.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(USDC, USDS, amount, minOut, receiver, 0)`
 *
 * On Ethereum mainnet (chain ID 1) the flow goes through Spark's
 * `UsdsPsmWrapper`:
 *
 * 1. `USDC.approve(UsdsPsmWrapper, amount)`
 * 2. `UsdsPsmWrapper.sellGem(receiver, amount)`
 *
 * In both cases the return type is an
 * {@link Erc20ApprovalRequired}, ready to be piped into `sendWith`:
 *
 * ```ts
 * import { mintUsds } from '@osero/client/actions';
 * import { sendWith } from '@osero/client/viem';
 *
 * const result = await mintUsds(client, {
 *   chainId: 8453,
 *   amount: parseUnits('100', 6),
 *   sender: wallet.account.address,
 * }).andThen(sendWith(wallet));
 *
 * if (result.isErr()) {
 *   console.error(result.error);
 *   return;
 * }
 * console.log('tx:', result.value.txHash);
 * ```
 */
export function mintUsds(
  client: OseroClient,
  request: MintUsdsRequest,
): ResultAsync<Erc20ApprovalRequired, MintUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  const receiver = request.receiver ?? request.sender;

  if (chain.isMainnet) {
    return okAsync(buildMainnetPlan(chain, request, receiver));
  }

  return buildL2Plan(client, chain, request, receiver);
}

function buildMainnetPlan(
  chain: ChainMetadata,
  request: MintUsdsRequest,
  receiver: Address,
): Erc20ApprovalRequired {
  const usdc = getToken(chain.chainId, 'USDC');
  const wrapperAddress = PSM_ADDRESSES[chain.chainId].psm;

  const sellGemData = encodeFunctionData({
    abi: usdsPsmWrapperAbi,
    functionName: 'sellGem',
    args: [receiver, request.amount],
  });

  const mainTransaction = makeTransactionRequest({
    chainId: chain.chainId,
    from: request.sender,
    to: wrapperAddress,
    data: sellGemData,
    operation: 'MINT_USDS',
  });

  return makeSingleApprovalPlan({
    chainId: chain.chainId,
    from: request.sender,
    token: usdc.address,
    spender: wrapperAddress,
    amount: request.amount,
    mainTransaction,
  });
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: MintUsdsRequest,
  receiver: Address,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const usds = getToken(chain.chainId, 'USDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;
  const referralCode = request.referralCode ?? 0n;

  return quoteL2MintUsds(client, chain, request.amount).map((quote): Erc20ApprovalRequired => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [usdc.address, usds.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'MINT_USDS',
    });

    return makeSingleApprovalPlan({
      chainId: chain.chainId,
      from: request.sender,
      token: usdc.address,
      spender: psmAddress,
      amount: request.amount,
      mainTransaction,
    });
  });
}

function quoteMainnetMintUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const litePsmAddress = PSM_ADDRESSES[chain.chainId].litePsm;

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: litePsmAddress,
      abi: litePsmAbi,
      functionName: 'tin',
    }),
    (err) => UnexpectedError.from(err),
  ).map((tin) => usdsFromUsdcViaSellGem(amount, tin));
}

function quoteL2MintUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const usds = getToken(chain.chainId, 'USDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: psmAddress,
      abi: psm3Abi,
      functionName: 'previewSwapExactIn',
      args: [usdc.address, usds.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
