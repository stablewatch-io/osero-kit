import { OseroClient, getChain, isErc20ApprovalRequired } from '@osero/client';
/**
 * Redeem sUSDS shares back into USDC on Base using a viem wallet.
 *
 * Flow on L2:
 *   1. sUSDS.approve(PSM3, shares)
 *   2. PSM3.swapExactIn(sUSDS, USDC, shares, minOut, receiver, 0)
 *
 * This example also shows the "eager" call shape for `sendWith`:
 * build the plan first, inspect it, then pass it directly to
 * `sendWith(wallet, plan)`. Useful when you want to confirm with the
 * user before broadcasting.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples viem:redeem-susds
 */
import { previewRedeemSUsds, redeemSUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describePlan, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const AMOUNT_SUSDS = parseUnits('5', 18); // 5 sUSDS shares

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  const transport = http(optionalRpcUrl(CHAIN_ID));
  const wallet = createWalletClient({ account, chain: base, transport });
  const client = OseroClient.create({ transports: { [CHAIN_ID]: transport } });

  banner(`redeemSUsds — ${chainMeta.name}`);
  console.log(`  sender: ${account.address}`);
  console.log(`  burn:   ${AMOUNT_SUSDS} sUSDS (raw 18-dec)`);

  const previewResult = await previewRedeemSUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_SUSDS,
  });
  if (previewResult.isErr()) {
    console.error('previewRedeemSUsds failed:', previewResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(`  quote:  ${formatToken(previewResult.value, 6, 'USDC')}`);

  // Eager form: build the plan explicitly, then inspect it before
  // sending. This is the pattern to reach for when you want the
  // human in the loop.
  const planResult = await redeemSUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_SUSDS,
    sender: account.address,
  });
  if (planResult.isErr()) {
    console.error('plan build failed:', planResult.error);
    process.exitCode = 1;
    return;
  }
  const plan = planResult.value;

  banner('Plan built');
  console.log(describePlan(plan));

  if (isErc20ApprovalRequired(plan)) {
    console.log(`\n  will approve ${plan.approvals[0]?.amount} of sUSDS to PSM3, then swap`);
  }

  // Direct form of sendWith — pass the plan in as the second arg.
  banner('Broadcasting');
  const result = await sendWith(wallet, plan);
  if (result.isErr()) {
    console.error('redeemSUsds failed:', result.error);
    process.exitCode = 1;
    return;
  }

  banner('Success');
  console.log(describeResult(result.value, chainMeta.explorerUrl));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
