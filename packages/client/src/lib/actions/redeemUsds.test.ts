import { decodeFunctionData, parseUnits } from 'viem';

import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { UnsupportedChainError, ValidationError } from '../errors.js';
import { usdcFromUsdsViaBuyGem } from '../math.js';
import { OseroClient } from '../OseroClient.js';
import { getToken } from '../tokens.js';
import { installMockPublicClient } from './_testing.js';
import { previewRedeemUsds, redeemUsds } from './redeemUsds.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;

describe('redeemUsds', () => {
  it('rejects an unsupported chain', async () => {
    const client = OseroClient.create();
    const result = await redeemUsds(client, {
      chainId: 137,
      amount: 1n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedChainError);
    }
  });

  it('rejects a zero amount', async () => {
    const client = OseroClient.create();
    const result = await redeemUsds(client, {
      chainId: 1,
      amount: 0n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  describe('previewRedeemUsds', () => {
    it('previews the mainnet USDC output using lite PSM tout', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 18);
      const tout = 10n ** 16n;
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tout') return tout;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewRedeemUsds(client, {
        chainId: 1,
        amount,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(usdcFromUsdsViaBuyGem(amount, tout));
    });

    it('previews the L2 USDC output via PSM3.previewSwapExactIn', async () => {
      const client = OseroClient.create();
      const quote = 999_500_000n;
      installMockPublicClient(client, 42161, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewRedeemUsds(client, {
        chainId: 42161,
        amount: parseUnits('1000', 18),
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(quote);
    });
  });

  describe('mainnet (chain 1)', () => {
    it('builds an Erc20ApprovalRequired via UsdsPsmWrapper.buyGem', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const tout = 0n;
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tout') return tout;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('1000', 18); // 1000 USDS
      const result = await redeemUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals[0]!.token).toBe(getToken(1, 'USDS').address);
      expect(plan.approvals[0]!.spender).toBe(PSM_ADDRESSES[1]!.psm);
      expect(plan.approvals[0]!.amount).toBe(amount);

      const main = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: plan.originalTransaction.data,
      });
      expect(main.functionName).toBe('buyGem');

      // The SDK backs out gemAmt from the caller's USDS budget and
      // then applies 5 bps slippage.
      const expectedGemAmt = (usdcFromUsdsViaBuyGem(amount, tout) * 9995n) / 10_000n;
      expect(main.args?.[0]).toBe(SENDER);
      expect(main.args?.[1]).toBe(expectedGemAmt);
      expect(plan.originalTransaction.operation).toBe('REDEEM_USDS_FOR_USDC');
    });
  });

  describe('L2 (chain 42161, Arbitrum)', () => {
    it('builds an Erc20ApprovalRequired via PSM3.swapExactIn(USDS, USDC)', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const quote = 999_500_000n; // 6-dec USDC
      installMockPublicClient(client, 42161, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('1000', 18);
      const result = await redeemUsds(client, {
        chainId: 42161,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.approvals[0]!.token).toBe(getToken(42161, 'USDS').address);
      expect(plan.approvals[0]!.spender).toBe(PSM_ADDRESSES[42161]!.psm);

      const main = decodeFunctionData({
        abi: psm3Abi,
        data: plan.originalTransaction.data,
      });
      expect(main.functionName).toBe('swapExactIn');
      const args = main.args as readonly unknown[];
      expect(args[0]).toBe(getToken(42161, 'USDS').address);
      expect(args[1]).toBe(getToken(42161, 'USDC').address);
      expect(args[2]).toBe(amount);
      expect(args[3]).toBe((quote * 9995n) / 10_000n);
    });
  });
});
