import { decodeFunctionData, parseUnits } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { UnsupportedChainError, ValidationError } from '../errors.js';
import { usdsFromUsdcViaSellGem } from '../math.js';
import { OseroClient } from '../OseroClient.js';
import { getToken } from '../tokens.js';
import { installMockPublicClient } from './_testing.js';
import { mintSUsds, previewMintSUsds } from './mintSUsds.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;
const RECEIVER = '0x2222222222222222222222222222222222222222' as const;

describe('mintSUsds', () => {
  it('rejects an unsupported chain', async () => {
    const client = OseroClient.create();
    const result = await mintSUsds(client, {
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
    const result = await mintSUsds(client, {
      chainId: 1,
      amount: 0n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  describe('previewMintSUsds', () => {
    it('previews the mainnet sUSDS output via sellGem math and previewDeposit', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 6);
      const tin = 10n ** 16n;
      const expectedUsdsOut = usdsFromUsdcViaSellGem(amount, tin);
      const sharesOut = parseUnits('990', 18);
      const mock = installMockPublicClient(client, 1, ({ functionName, args }) => {
        if (functionName === 'tin') return tin;
        if (functionName === 'previewDeposit') {
          expect(args).toEqual([expectedUsdsOut]);
          return sharesOut;
        }
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewMintSUsds(client, {
        chainId: 1,
        amount,
      });

      expect(mock.readContract).toHaveBeenCalledTimes(2);
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(sharesOut);
    });

    it('previews the L2 sUSDS output via PSM3.previewSwapExactIn', async () => {
      const client = OseroClient.create();
      const quote = parseUnits('999.5', 18);
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewMintSUsds(client, {
        chainId: 8453,
        amount: parseUnits('1000', 6),
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(quote);
    });
  });

  describe('mainnet (chain 1)', () => {
    it('builds a two-phase plan: sellGem then deposit', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 6);
      const tin = 0n;

      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tin') return tin;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await mintSUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('MultiStepExecution');
      if (plan.__typename !== 'MultiStepExecution') return;
      expect(plan.steps).toHaveLength(2);

      // Phase 1 — approve USDC + sellGem(SENDER, amount)
      const phase1 = plan.steps[0]!;
      expect(phase1.__typename).toBe('Erc20ApprovalRequired');
      if (phase1.__typename !== 'Erc20ApprovalRequired') return;
      expect(phase1.approvals[0]!.token).toBe(getToken(1, 'USDC').address);
      expect(phase1.approvals[0]!.spender).toBe(PSM_ADDRESSES[1]!.psm);
      expect(phase1.approvals[0]!.amount).toBe(amount);

      const sellGem = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: phase1.originalTransaction.data,
      });
      expect(sellGem.functionName).toBe('sellGem');
      expect(sellGem.args?.[0]).toBe(SENDER);
      expect(sellGem.args?.[1]).toBe(amount);

      // Phase 2 — approve USDS + deposit(usdsOut, SENDER)
      const usdsOut = usdsFromUsdcViaSellGem(amount, tin);
      const phase2 = plan.steps[1]!;
      expect(phase2.__typename).toBe('Erc20ApprovalRequired');
      if (phase2.__typename !== 'Erc20ApprovalRequired') return;
      expect(phase2.approvals[0]!.token).toBe(getToken(1, 'USDS').address);
      expect(phase2.approvals[0]!.spender).toBe(getToken(1, 'sUSDS').address);
      expect(phase2.approvals[0]!.amount).toBe(usdsOut);

      const deposit = decodeFunctionData({
        abi: erc4626Abi,
        data: phase2.originalTransaction.data,
      });
      expect(deposit.functionName).toBe('deposit');
      expect(deposit.args?.[0]).toBe(usdsOut);
      expect(deposit.args?.[1]).toBe(SENDER); // default receiver
      expect(phase2.originalTransaction.operation).toBe('DEPOSIT_USDS_FOR_SUSDS');
    });

    it('respects an explicit receiver while keeping sender as the USDS intermediary', async () => {
      const client = OseroClient.create();
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tin') return 0n;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await mintSUsds(client, {
        chainId: 1,
        amount: parseUnits('1000', 6),
        sender: SENDER,
        receiver: RECEIVER,
      });
      if (!result.isOk()) throw result.error;
      if (result.value.__typename !== 'MultiStepExecution') return;

      const phase1 = result.value.steps[0]!;
      if (phase1.__typename !== 'Erc20ApprovalRequired') return;
      const sellGemArgs = decodeFunctionData({
        abi: usdsPsmWrapperAbi,
        data: phase1.originalTransaction.data,
      }).args as readonly unknown[];
      // sellGem routes USDS back to SENDER (the intermediate holder)
      expect(sellGemArgs[0]).toBe(SENDER);

      const phase2 = result.value.steps[1]!;
      if (phase2.__typename !== 'Erc20ApprovalRequired') return;
      const depositArgs = decodeFunctionData({
        abi: erc4626Abi,
        data: phase2.originalTransaction.data,
      }).args as readonly unknown[];
      // deposit routes sUSDS to the final receiver
      expect(depositArgs[1]).toBe(RECEIVER);
    });

    it('accounts for a non-zero tin when computing usdsOut', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 6);
      const tin = 10n ** 16n; // 1%
      installMockPublicClient(client, 1, ({ functionName }) => {
        if (functionName === 'tin') return tin;
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await mintSUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
      });
      if (!result.isOk()) throw result.error;
      if (result.value.__typename !== 'MultiStepExecution') return;
      const phase2 = result.value.steps[1]!;
      if (phase2.__typename !== 'Erc20ApprovalRequired') return;

      const expectedUsdsOut = usdsFromUsdcViaSellGem(amount, tin);
      expect(phase2.approvals[0]!.amount).toBe(expectedUsdsOut);
    });
  });

  describe('L2 (chain 8453, Base)', () => {
    it('builds an Erc20ApprovalRequired via PSM3.swapExactIn(USDC, sUSDS)', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const quote = 999_500_000_000_000_000_000n; // mock preview output
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('1000', 6);
      const result = await mintSUsds(client, {
        chainId: 8453,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      if (plan.__typename !== 'Erc20ApprovalRequired') return;

      const main = decodeFunctionData({
        abi: psm3Abi,
        data: plan.originalTransaction.data,
      });
      expect(main.functionName).toBe('swapExactIn');
      const args = main.args as readonly unknown[];
      expect(args[0]).toBe(getToken(8453, 'USDC').address);
      expect(args[1]).toBe(getToken(8453, 'sUSDS').address);
      expect(args[2]).toBe(amount);
      expect(args[3]).toBe((quote * 9995n) / 10_000n);
      expect(args[4]).toBe(SENDER);
      expect(plan.originalTransaction.operation).toBe('MINT_SUSDS');
    });
  });
});
