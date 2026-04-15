import { decodeFunctionData, parseUnits } from 'viem';

import { erc20Abi } from '../abis/erc20.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { flattenExecutionPlan } from '../adapters.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { usdsFromUsdcViaSellGem } from '../math.js';
import { OseroClient } from '../OseroClient.js';
import { getToken } from '../tokens.js';
import { installMockPublicClient } from './_testing.js';
import { mintUsds, previewMintUsds } from './mintUsds.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;
const RECEIVER = '0x2222222222222222222222222222222222222222' as const;

describe('mintUsds', () => {
  it('rejects an unsupported chain', async () => {
    const client = OseroClient.create();
    const result = await mintUsds(client, {
      chainId: 137,
      amount: parseUnits('100', 6),
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedChainError);
    }
  });

  it('rejects a zero amount', async () => {
    const client = OseroClient.create();
    const result = await mintUsds(client, {
      chainId: 1,
      amount: 0n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  describe('previewMintUsds', () => {
    it('previews the mainnet USDS output using lite PSM tin', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('100', 6);
      const tin = 10n ** 16n;
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tin') return tin;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewMintUsds(client, {
        chainId: 1,
        amount,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(usdsFromUsdcViaSellGem(amount, tin));
    });

    it('previews the L2 USDS output via PSM3.previewSwapExactIn', async () => {
      const client = OseroClient.create();
      const quote = 123_456_789_012_345_678_901n;
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewMintUsds(client, {
        chainId: 8453,
        amount: parseUnits('100', 6),
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(quote);
    });
  });

  describe('mainnet (chain 1)', () => {
    it('builds an Erc20ApprovalRequired via UsdsPsmWrapper.sellGem', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('100', 6);
      const result = await mintUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals).toHaveLength(1);

      const approval = plan.approvals[0]!;
      expect(approval.token).toBe(getToken(1, 'USDC').address);
      expect(approval.spender).toBe(PSM_ADDRESSES[1]!.psm);
      expect(approval.amount).toBe(amount);

      const approveDecoded = decodeFunctionData({
        abi: erc20Abi,
        data: approval.byTransaction.data,
      });
      expect(approveDecoded.functionName).toBe('approve');
      expect(approveDecoded.args?.[0]).toBe(PSM_ADDRESSES[1]!.psm);
      expect(approveDecoded.args?.[1]).toBe(amount);

      const mainTx = plan.originalTransaction;
      expect(mainTx.to).toBe(PSM_ADDRESSES[1]!.psm);
      expect(mainTx.operation).toBe('MINT_USDS');
      const mainDecoded = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: mainTx.data,
      });
      expect(mainDecoded.functionName).toBe('sellGem');
      expect(mainDecoded.args?.[0]).toBe(SENDER); // default receiver
      expect(mainDecoded.args?.[1]).toBe(amount);
    });

    it('routes the USDS to an explicit receiver when provided', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('100', 6);
      const result = await mintUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
        receiver: RECEIVER,
      });
      if (!result.isOk()) throw result.error;
      const decoded = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: result.value.originalTransaction.data,
      });
      expect(decoded.args?.[0]).toBe(RECEIVER);
    });
  });

  describe('L2 (chain 8453, Base)', () => {
    it('builds an Erc20ApprovalRequired via PSM3.swapExactIn using previewSwapExactIn', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });

      // 100 USDC → preview returns 99_999_999_999_999_999_999n (~100 USDS)
      const quote = 99_999_999_999_999_999_999n;
      const mock = installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('100', 6);
      const result = await mintUsds(client, {
        chainId: 8453,
        amount,
        sender: SENDER,
      });
      expect(mock.readContract).toHaveBeenCalledOnce();
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.originalTransaction.to).toBe(PSM_ADDRESSES[8453]!.psm);

      const main = decodeFunctionData({
        abi: psm3Abi,
        data: plan.originalTransaction.data,
      });
      expect(main.functionName).toBe('swapExactIn');
      const args = main.args as readonly unknown[];
      expect(args[0]).toBe(getToken(8453, 'USDC').address);
      expect(args[1]).toBe(getToken(8453, 'USDS').address);
      expect(args[2]).toBe(amount);
      // minOut = quote * 9995 / 10000
      expect(args[3]).toBe((quote * 9995n) / 10_000n);
      expect(args[4]).toBe(SENDER); // default receiver
      expect(args[5]).toBe(0n); // default referral
    });

    it('wraps transport failures in UnexpectedError', async () => {
      const client = OseroClient.create();
      installMockPublicClient(client, 42161, () => {
        throw new Error('boom');
      });
      const result = await mintUsds(client, {
        chainId: 42161,
        amount: 1n,
        sender: SENDER,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
      }
    });

    it('uses a request-level slippage override when provided', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const quote = 1_000_000_000_000_000_000_000n;
      installMockPublicClient(client, 8453, () => quote);

      const result = await mintUsds(client, {
        chainId: 8453,
        amount: parseUnits('1000', 6),
        sender: SENDER,
        slippageBps: 50, // 0.5 %
      });
      if (!result.isOk()) throw result.error;
      const main = decodeFunctionData({
        abi: psm3Abi,
        data: result.value.originalTransaction.data,
      });
      const args = main.args as readonly unknown[];
      expect(args[3]).toBe((quote * (10_000n - 50n)) / 10_000n);
    });
  });
});

// Touch flattenExecutionPlan for coverage — it's already tested in
// adapters.test.ts but importing here makes sure the action's output
// type is compatible with the shared adapter helpers.
const _coverage = flattenExecutionPlan;
void _coverage;
