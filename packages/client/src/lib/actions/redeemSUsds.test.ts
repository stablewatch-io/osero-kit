import { decodeFunctionData, parseUnits } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { UnsupportedChainError, ValidationError } from '../errors.js';
import { usdcFromUsdsViaBuyGem } from '../math.js';
import { OseroClient } from '../OseroClient.js';
import { getToken } from '../tokens.js';
import { installMockPublicClient } from './_testing.js';
import { previewRedeemSUsds, redeemSUsds } from './redeemSUsds.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;

describe('redeemSUsds', () => {
  it('rejects an unsupported chain', async () => {
    const client = OseroClient.create();
    const result = await redeemSUsds(client, {
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
    const result = await redeemSUsds(client, {
      chainId: 1,
      amount: 0n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  describe('previewRedeemSUsds', () => {
    it('previews the mainnet USDC output via previewRedeem and lite PSM tout', async () => {
      const client = OseroClient.create();
      const shares = parseUnits('1000', 18);
      const usdsOut = parseUnits('1005', 18);
      const tout = 10n ** 16n;
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'previewRedeem') return usdsOut;
        if (functionName === 'tout') return tout;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewRedeemSUsds(client, {
        chainId: 1,
        amount: shares,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(usdcFromUsdsViaBuyGem(usdsOut, tout));
    });

    it('previews the L2 USDC output via PSM3.previewSwapExactIn', async () => {
      const client = OseroClient.create();
      const quote = 999_500_000n;
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewRedeemSUsds(client, {
        chainId: 8453,
        amount: parseUnits('1000', 18),
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(quote);
    });
  });

  describe('mainnet (chain 1)', () => {
    it('builds a two-phase plan: redeem then approve+buyGem', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const shares = parseUnits('1000', 18);
      const usdsOut = parseUnits('1005', 18); // some yield accrued
      const tout = 0n;

      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'previewRedeem') return usdsOut;
        if (functionName === 'tout') return tout;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await redeemSUsds(client, {
        chainId: 1,
        amount: shares,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      if (result.value.__typename !== 'MultiStepExecution') return;

      const [step1, step2] = result.value.steps;

      // Phase 1 — redeem uses no approval (sender is the owner)
      expect(step1!.__typename).toBe('TransactionRequest');
      if (step1!.__typename !== 'TransactionRequest') return;
      const redeem = decodeFunctionData({
        abi: erc4626Abi,
        data: step1!.data,
      });
      expect(redeem.functionName).toBe('redeem');
      expect(redeem.args?.[0]).toBe(shares);
      expect(redeem.args?.[1]).toBe(SENDER);
      expect(redeem.args?.[2]).toBe(SENDER);
      expect(step1!.operation).toBe('REDEEM_SUSDS_FOR_USDS');

      // Phase 2 — approve USDS to wrapper + buyGem
      expect(step2!.__typename).toBe('Erc20ApprovalRequired');
      if (step2!.__typename !== 'Erc20ApprovalRequired') return;
      expect(step2!.approvals[0]!.token).toBe(getToken(1, 'USDS').address);
      expect(step2!.approvals[0]!.spender).toBe(PSM_ADDRESSES[1]!.psm);
      expect(step2!.approvals[0]!.amount).toBe(usdsOut);

      const buyGem = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: step2!.originalTransaction.data,
      });
      expect(buyGem.functionName).toBe('buyGem');
      const expectedGemAmt = (usdcFromUsdsViaBuyGem(usdsOut, tout) * 9995n) / 10_000n;
      expect(buyGem.args?.[1]).toBe(expectedGemAmt);
    });
  });

  describe('L2 (chain 8453, Base)', () => {
    it('builds an Erc20ApprovalRequired via PSM3.swapExactIn(sUSDS, USDC)', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const quote = 999_500_000n;
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('1000', 18);
      const result = await redeemSUsds(client, {
        chainId: 8453,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      if (result.value.__typename !== 'Erc20ApprovalRequired') return;

      expect(result.value.approvals[0]!.token).toBe(getToken(8453, 'sUSDS').address);
      const main = decodeFunctionData({
        abi: psm3Abi,
        data: result.value.originalTransaction.data,
      });
      expect(main.functionName).toBe('swapExactIn');
      const args = main.args as readonly unknown[];
      expect(args[0]).toBe(getToken(8453, 'sUSDS').address);
      expect(args[1]).toBe(getToken(8453, 'USDC').address);
      expect(result.value.originalTransaction.operation).toBe('REDEEM_SUSDS_FOR_USDC');
    });
  });
});
