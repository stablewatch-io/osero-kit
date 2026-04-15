import { type Address, encodeFunctionData } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage, usdsFromUsdcViaSellGem } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { errAsync, okAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type { Erc20ApprovalRequired, MultiStepExecution } from '../types.js';

/**
 * Parameters accepted by {@link mintSUsds}.
 */
export type MintSUsdsRequest = {
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
   * The wallet that pays the USDC. Used as the `from` address on
   * every transaction in the returned plan.
   *
   * On Ethereum mainnet, `sender` is also the intermediate holder of
   * the USDS bridge-amount between the Lite-PSM `sellGem` call and
   * the sUSDS `deposit` call, even if `receiver` is a different
   * address.
   */
  readonly sender: Address;

  /**
   * The address that receives the resulting sUSDS shares. Defaults
   * to {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points) applied to the PSM3
   * `previewSwapExactIn` quote on L2s. Ignored on Ethereum mainnet
   * because both the Lite PSM and ERC-4626 deposit are
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
 * Parameters accepted by {@link previewMintSUsds}.
 */
export type PreviewMintSUsdsRequest = {
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

export type MintSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much sUSDS an exact-in {@link mintSUsds} flow would
 * return for the given USDC amount.
 */
export function previewMintSUsds(
  client: OseroClient,
  request: PreviewMintSUsdsRequest,
): ResultAsync<bigint, MintSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetMintSUsds(client, chain, request.amount);
  }

  return quoteL2MintSUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that mints sUSDS (Savings USDS)
 * from USDC on the target chain. The plan is wallet-agnostic —
 * pass it to {@link sendWith} from `@osero/client/viem` or
 * `@osero/client/ethers` to actually broadcast the transactions.
 *
 * ### L2 path (Base, Arbitrum One, OP Mainnet, Unichain)
 *
 * Uses a single approval-then-swap through Spark's PSM3 — USDC is
 * exchanged for sUSDS directly in one atomic call. The returned
 * plan is an {@link Erc20ApprovalRequired} with two transactions:
 *
 * 1. `USDC.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(USDC, sUSDS, amount, minShares, receiver, 0)`
 *
 * ### Mainnet path (Ethereum)
 *
 * Uses two phases because mainnet has no PSM3: first USDC is
 * converted to USDS via Spark's `UsdsPsmWrapper`, then USDS is
 * deposited into sUSDS via the ERC-4626 vault. The returned plan is
 * a {@link MultiStepExecution} with four transactions:
 *
 * 1. `USDC.approve(UsdsPsmWrapper, amount)`
 * 2. `UsdsPsmWrapper.sellGem(sender, amount)` — sender receives USDS
 * 3. `USDS.approve(sUSDS, usdsOut)`
 * 4. `sUSDS.deposit(usdsOut, receiver)` — receiver gets sUSDS shares
 *
 * The exact USDS bridge amount is computed off-chain from
 * `LitePSM.tin()`, which is governance-set and has been `0` since
 * launch. The SDK still reads it on every call so that a future
 * change is handled automatically.
 *
 * ```ts
 * import { mintSUsds } from '@osero/client/actions';
 * import { sendWith } from '@osero/client/viem';
 * import { parseUnits } from 'viem';
 *
 * const result = await mintSUsds(client, {
 *   chainId: 1,
 *   amount: parseUnits('1000', 6),
 *   sender: wallet.account.address,
 * }).andThen(sendWith(wallet));
 * ```
 */
export function mintSUsds(
  client: OseroClient,
  request: MintSUsdsRequest,
): ResultAsync<Erc20ApprovalRequired | MultiStepExecution, MintSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  const receiver = request.receiver ?? request.sender;

  if (chain.isMainnet) {
    return buildMainnetPlan(client, chain, request, receiver);
  }

  return buildL2Plan(client, chain, request, receiver);
}

function buildMainnetPlan(
  client: OseroClient,
  chain: ChainMetadata,
  request: MintSUsdsRequest,
  receiver: Address,
): ResultAsync<MultiStepExecution, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddresses = PSM_ADDRESSES[chain.chainId];
  const wrapperAddress = psmAddresses.psm;
  const litePsmAddress = psmAddresses.litePsm;

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  return quoteMainnetUsdsBridgeAmount(client, chain, request.amount, litePsmAddress).map(
    (usdsOut): MultiStepExecution => {
      // Phase 1 — USDC → USDS via Spark UsdsPsmWrapper.sellGem.
      // USDS goes to `sender` (the intermediate holder) because `sender`
      // is the one who will approve it into sUSDS in phase 2.
      const sellGemData = encodeFunctionData({
        abi: usdsPsmWrapperAbi,
        functionName: 'sellGem',
        args: [request.sender, request.amount],
      });
      const sellGemTx = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: wrapperAddress,
        data: sellGemData,
        operation: 'MINT_USDS',
      });
      const phase1 = makeSingleApprovalPlan({
        chainId: chain.chainId,
        from: request.sender,
        token: usdc.address,
        spender: wrapperAddress,
        amount: request.amount,
        mainTransaction: sellGemTx,
      });

      // Phase 2 — USDS → sUSDS via the ERC-4626 vault. The vault is
      // at the sUSDS address and must be approved as the spender of
      // the sender's USDS.
      const depositData = encodeFunctionData({
        abi: erc4626Abi,
        functionName: 'deposit',
        args: [usdsOut, receiver],
      });
      const depositTx = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: susds.address,
        data: depositData,
        operation: 'DEPOSIT_USDS_FOR_SUSDS',
      });
      const phase2 = makeSingleApprovalPlan({
        chainId: chain.chainId,
        from: request.sender,
        token: usds.address,
        spender: susds.address,
        amount: usdsOut,
        mainTransaction: depositTx,
      });

      return makeMultiStepPlan([phase1, phase2]);
    },
  );
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: MintSUsdsRequest,
  receiver: Address,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;
  const referralCode = request.referralCode ?? 0n;

  return quoteL2MintSUsds(client, chain, request.amount).andThen((quote) => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [usdc.address, susds.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'MINT_SUSDS',
    });

    return okAsync(
      makeSingleApprovalPlan({
        chainId: chain.chainId,
        from: request.sender,
        token: usdc.address,
        spender: psmAddress,
        amount: request.amount,
        mainTransaction,
      }),
    );
  });
}

function quoteMainnetMintSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const susds = getToken(chain.chainId, 'sUSDS');
  const litePsmAddress = PSM_ADDRESSES[chain.chainId].litePsm;

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  const publicClient = client.getPublicClient(chain.chainId);

  return quoteMainnetUsdsBridgeAmount(client, chain, amount, litePsmAddress).andThen((usdsOut) =>
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: susds.address,
        abi: erc4626Abi,
        functionName: 'previewDeposit',
        args: [usdsOut],
      }),
      (err) => UnexpectedError.from(err),
    ),
  );
}

function quoteMainnetUsdsBridgeAmount(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
  litePsmAddress = PSM_ADDRESSES[chain.chainId].litePsm,
): ResultAsync<bigint, UnexpectedError> {
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

function quoteL2MintSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: psmAddress,
      abi: psm3Abi,
      functionName: 'previewSwapExactIn',
      args: [usdc.address, susds.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
