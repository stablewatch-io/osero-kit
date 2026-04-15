import { type Address, encodeFunctionData } from 'viem';

import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage, usdcFromUsdsViaBuyGem } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { errAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type { Erc20ApprovalRequired } from '../types.js';

/**
 * Parameters accepted by {@link redeemUsds}.
 */
export type RedeemUsdsRequest = {
  /**
   * The chain on which the redemption should happen. Must be one of
   * the supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDS to spend, in USDS's 18 decimals (use
   * `parseUnits(amount, 18)` from viem).
   *
   * This is the upper bound — the actual USDS pulled by the wrapper
   * on Ethereum mainnet may be slightly less due to floor rounding
   * when computing the gem output. The unused dust stays in
   * `sender`'s USDS balance.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;

  /**
   * The wallet that will spend the USDS. Used as the `from` on
   * every transaction in the returned plan.
   */
  readonly sender: Address;

  /**
   * The address that receives the resulting USDC. Defaults to
   * {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points) — on L2s the floor is
   * applied to the `previewSwapExactIn` output. On mainnet the
   * tolerance is used to reserve headroom inside the requested
   * `gemAmt` so that a small `tout` increase between plan and
   * execution does not cause the tx to revert.
   *
   * @defaultValue {@link ClientConfig.defaultSlippageBps} (5 bps)
   */
  readonly slippageBps?: number;

  /**
   * Opaque referral code for L2 PSM3 calls. Ignored on mainnet.
   *
   * @defaultValue 0n
   */
  readonly referralCode?: bigint;
};

/**
 * Parameters accepted by {@link previewRedeemUsds}.
 */
export type PreviewRedeemUsdsRequest = {
  /**
   * The chain on which the preview should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDS to spend, in USDS's native 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;
};

export type RedeemUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much USDC an exact-in {@link redeemUsds} flow would
 * return for the given USDS amount.
 */
export function previewRedeemUsds(
  client: OseroClient,
  request: PreviewRedeemUsdsRequest,
): ResultAsync<bigint, RedeemUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetRedeemUsds(client, chain, request.amount);
  }

  return quoteL2RedeemUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that redeems USDS back into USDC
 * on the target chain. The inverse of {@link mintUsds}.
 *
 * ### L2 path
 *
 * Uses a single approval-then-swap through Spark's PSM3:
 *
 * 1. `USDS.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(USDS, USDC, amount, minOut, receiver, 0)`
 *
 * ### Mainnet path
 *
 * Uses Spark's `UsdsPsmWrapper.buyGem`, which has **exact-out**
 * semantics: the argument is the USDC *output* in 6 decimals, not
 * the USDS *input* in 18 decimals. The SDK backs out `gemAmt` from
 * the caller's USDS budget and the current `tout`, leaving a small
 * safety margin proportional to `slippageBps`:
 *
 * 1. `USDS.approve(UsdsPsmWrapper, amount)`
 * 2. `UsdsPsmWrapper.buyGem(receiver, gemAmt)`
 *
 * Any USDS not consumed by the wrapper (a handful of wei at most)
 * remains in `sender`'s USDS balance.
 */
export function redeemUsds(
  client: OseroClient,
  request: RedeemUsdsRequest,
): ResultAsync<Erc20ApprovalRequired, RedeemUsdsError> {
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
  request: RedeemUsdsRequest,
  receiver: Address,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usds = getToken(chain.chainId, 'USDS');
  const psmAddresses = PSM_ADDRESSES[chain.chainId];
  const wrapperAddress = psmAddresses.psm;
  const litePsmAddress = psmAddresses.litePsm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  return quoteMainnetRedeemUsds(client, chain, request.amount, litePsmAddress).map(
    (baseGemAmt): Erc20ApprovalRequired => {
      // Exact-in from the caller's point of view: the caller is
      // willing to spend up to `request.amount` USDS. We back out
      // `gemAmt` (USDC out, 6-dec) from the wrapper's exact-out
      // formula, then reduce it by `slippageBps` so that a small
      // `tout` bump between plan and execution still leaves the
      // approval large enough to cover the pulled USDS.
      const gemAmt = applySlippage(baseGemAmt, slippageBps);

      const buyGemData = encodeFunctionData({
        abi: usdsPsmWrapperAbi,
        functionName: 'buyGem',
        args: [receiver, gemAmt],
      });

      const mainTransaction = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: wrapperAddress,
        data: buyGemData,
        operation: 'REDEEM_USDS_FOR_USDC',
      });

      return makeSingleApprovalPlan({
        chainId: chain.chainId,
        from: request.sender,
        token: usds.address,
        spender: wrapperAddress,
        amount: request.amount,
        mainTransaction,
      });
    },
  );
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: RedeemUsdsRequest,
  receiver: Address,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const usds = getToken(chain.chainId, 'USDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;
  const referralCode = request.referralCode ?? 0n;

  return quoteL2RedeemUsds(client, chain, request.amount).map((quote): Erc20ApprovalRequired => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [usds.address, usdc.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'REDEEM_USDS_FOR_USDC',
    });

    return makeSingleApprovalPlan({
      chainId: chain.chainId,
      from: request.sender,
      token: usds.address,
      spender: psmAddress,
      amount: request.amount,
      mainTransaction,
    });
  });
}

function quoteMainnetRedeemUsds(
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
      functionName: 'tout',
    }),
    (err) => UnexpectedError.from(err),
  ).map((tout) => usdcFromUsdsViaBuyGem(amount, tout));
}

function quoteL2RedeemUsds(
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
      args: [usds.address, usdc.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
