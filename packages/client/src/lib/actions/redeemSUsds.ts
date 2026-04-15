import { type Address, encodeFunctionData } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage, usdcFromUsdsViaBuyGem } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { errAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type { Erc20ApprovalRequired, MultiStepExecution } from '../types.js';

/**
 * Parameters accepted by {@link redeemSUsds}.
 */
export type RedeemSUsdsRequest = {
  /**
   * The chain on which the redemption should happen. Must be one of
   * the supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of sUSDS shares to burn, in sUSDS's 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;

  /**
   * The wallet that owns the sUSDS shares. On Ethereum mainnet,
   * this wallet also holds the intermediate USDS between the
   * ERC-4626 `redeem` call and the Lite PSM `buyGem` call.
   */
  readonly sender: Address;

  /**
   * The address that receives the final USDC. Defaults to
   * {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points).
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
 * Parameters accepted by {@link previewRedeemSUsds}.
 */
export type PreviewRedeemSUsdsRequest = {
  /**
   * The chain on which the preview should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of sUSDS shares to burn, in sUSDS's native 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;
};

export type RedeemSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much USDC an exact-in {@link redeemSUsds} flow would
 * return for the given sUSDS amount.
 */
export function previewRedeemSUsds(
  client: OseroClient,
  request: PreviewRedeemSUsdsRequest,
): ResultAsync<bigint, RedeemSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetRedeemSUsds(client, chain, request.amount);
  }

  return quoteL2RedeemSUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that redeems sUSDS shares back
 * into USDC on the target chain. The inverse of {@link mintSUsds}.
 *
 * ### L2 path
 *
 * Uses a single approval-then-swap through Spark's PSM3:
 *
 * 1. `sUSDS.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(sUSDS, USDC, amount, minOut, receiver, 0)`
 *
 * ### Mainnet path
 *
 * Uses two phases because mainnet has no PSM3. The ERC-4626 redeem
 * needs no approval (the sender is the owner of the shares) but
 * the subsequent `buyGem` call does:
 *
 * 1. `sUSDS.redeem(amount, sender, sender)` — sender gets USDS
 * 2. `USDS.approve(UsdsPsmWrapper, usdsOut)`
 * 3. `UsdsPsmWrapper.buyGem(receiver, gemAmt)`
 *
 * `usdsOut` is read from `sUSDS.previewRedeem(amount)` at plan
 * time; the live number at execution time is strictly greater
 * because the SSR only accrues upwards, so the approval always
 * covers it. Any USDS dust left over after `buyGem` stays in
 * `sender`'s USDS balance.
 */
export function redeemSUsds(
  client: OseroClient,
  request: RedeemSUsdsRequest,
): ResultAsync<Erc20ApprovalRequired | MultiStepExecution, RedeemSUsdsError> {
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
  request: RedeemSUsdsRequest,
  receiver: Address,
): ResultAsync<MultiStepExecution, UnexpectedError> {
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
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

  return readMainnetRedeemSUsdsQuoteInputs(client, chain, request.amount, litePsmAddress).map(
    ({ usdsOut, tout }): MultiStepExecution => {
      // Phase 1 — sUSDS.redeem(shares, sender, sender).
      // Sender is both owner and receiver of the USDS, so no
      // allowance is needed. The vault burns `shares` from `sender`
      // and transfers `assets` (≈ usdsOut) USDS back.
      const redeemData = encodeFunctionData({
        abi: erc4626Abi,
        functionName: 'redeem',
        args: [request.amount, request.sender, request.sender],
      });
      const redeemTx = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: susds.address,
        data: redeemData,
        operation: 'REDEEM_SUSDS_FOR_USDS',
      });

      // Phase 2 — approve USDS to the wrapper, then buyGem. The
      // `gemAmt` is computed from `usdsOut` and current `tout`, then
      // reduced by `slippageBps` to leave headroom for tout
      // fluctuations.
      const baseGemAmt = usdcFromUsdsViaBuyGem(usdsOut, tout);
      const gemAmt = applySlippage(baseGemAmt, slippageBps);

      const buyGemData = encodeFunctionData({
        abi: usdsPsmWrapperAbi,
        functionName: 'buyGem',
        args: [receiver, gemAmt],
      });
      const buyGemTx = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: wrapperAddress,
        data: buyGemData,
        operation: 'REDEEM_USDS_FOR_USDC',
      });
      const phase2 = makeSingleApprovalPlan({
        chainId: chain.chainId,
        from: request.sender,
        token: usds.address,
        spender: wrapperAddress,
        amount: usdsOut,
        mainTransaction: buyGemTx,
      });

      return makeMultiStepPlan([redeemTx, phase2]);
    },
  );
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: RedeemSUsdsRequest,
  receiver: Address,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;
  const referralCode = request.referralCode ?? 0n;

  return quoteL2RedeemSUsds(client, chain, request.amount).map((quote): Erc20ApprovalRequired => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [susds.address, usdc.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'REDEEM_SUSDS_FOR_USDC',
    });

    return makeSingleApprovalPlan({
      chainId: chain.chainId,
      from: request.sender,
      token: susds.address,
      spender: psmAddress,
      amount: request.amount,
      mainTransaction,
    });
  });
}

function quoteMainnetRedeemSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  return readMainnetRedeemSUsdsQuoteInputs(client, chain, amount).map(({ usdsOut, tout }) =>
    usdcFromUsdsViaBuyGem(usdsOut, tout),
  );
}

function readMainnetRedeemSUsdsQuoteInputs(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
  litePsmAddress = PSM_ADDRESSES[chain.chainId].litePsm,
): ResultAsync<{ readonly usdsOut: bigint; readonly tout: bigint }, UnexpectedError> {
  const susds = getToken(chain.chainId, 'sUSDS');

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.combine([
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: susds.address,
        abi: erc4626Abi,
        functionName: 'previewRedeem',
        args: [amount],
      }),
      (err) => UnexpectedError.from(err),
    ),
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: litePsmAddress,
        abi: litePsmAbi,
        functionName: 'tout',
      }),
      (err) => UnexpectedError.from(err),
    ),
  ]).map(([usdsOut, tout]) => ({ usdsOut, tout }));
}

function quoteL2RedeemSUsds(
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
      args: [susds.address, usdc.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
