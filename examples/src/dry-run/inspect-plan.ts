import { OseroClient } from '@osero/client';
/**
 * Walk through every action the SDK exposes and print the
 * `ExecutionPlan` each one builds for a hypothetical sender. This is
 * the safest way to understand the SDK: no wallet, no private key,
 * no transactions — just a handful of `eth_call`s to the public RPCs.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples dry-run:inspect-plan
 */
import {
  mintSUsds,
  mintUsds,
  previewMintSUsds,
  previewMintUsds,
  previewRedeemSUsds,
  previewRedeemUsds,
  redeemSUsds,
  redeemUsds,
} from '@osero/client/actions';
import { http, parseUnits } from 'viem';

import { optionalRpcUrl } from '../shared/env.js';
import { banner, describePlan, formatToken } from '../shared/format.js';

// A placeholder sender. The plan is built against this address so the
// calldata's `from` + PSM3 `receiver` arguments are deterministic.
// No private key, no signing — the address is just data.
const SENDER = '0x1111111111111111111111111111111111111111' as const;

// Base (8453) is the default for examples — L2 path, single tx
// approvals, cheap gas. Swap to 1 below to see the mainnet
// MultiStepExecution branch for sUSDS.
const CHAIN_ID_L2 = 8453 as const;
const CHAIN_ID_MAINNET = 1 as const;

async function main() {
  const client = OseroClient.create({
    transports: {
      [CHAIN_ID_L2]: http(optionalRpcUrl(CHAIN_ID_L2)),
      [CHAIN_ID_MAINNET]: http(optionalRpcUrl(CHAIN_ID_MAINNET)),
    },
  });

  const hundredUsdc = parseUnits('100', 6);
  const hundredUsds = parseUnits('100', 18);
  const tenSusds = parseUnits('10', 18);

  banner(`mintUsds — USDC → USDS on Base (${CHAIN_ID_L2})`);
  const mintUsdsQuote = await previewMintUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsdc,
  });
  if (mintUsdsQuote.isErr()) throw mintUsdsQuote.error;
  console.log(`quote: ${formatToken(mintUsdsQuote.value, 18, 'USDS')}`);
  const mintUsdsPlan = await mintUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsdc,
    sender: SENDER,
  });
  if (mintUsdsPlan.isErr()) throw mintUsdsPlan.error;
  console.log(describePlan(mintUsdsPlan.value));

  banner(`mintSUsds — USDC → sUSDS on Base (L2, single phase)`);
  const mintSusdsL2Quote = await previewMintSUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsdc,
  });
  if (mintSusdsL2Quote.isErr()) throw mintSusdsL2Quote.error;
  console.log(`quote: ${formatToken(mintSusdsL2Quote.value, 18, 'sUSDS')}`);
  const mintSusdsL2Plan = await mintSUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsdc,
    sender: SENDER,
  });
  if (mintSusdsL2Plan.isErr()) throw mintSusdsL2Plan.error;
  console.log(describePlan(mintSusdsL2Plan.value));

  banner(`mintSUsds — USDC → sUSDS on mainnet (MultiStepExecution)`);
  const mintSusdsMainnetQuote = await previewMintSUsds(client, {
    chainId: CHAIN_ID_MAINNET,
    amount: hundredUsdc,
  });
  if (mintSusdsMainnetQuote.isErr()) throw mintSusdsMainnetQuote.error;
  console.log(`quote: ${formatToken(mintSusdsMainnetQuote.value, 18, 'sUSDS')}`);
  const mintSusdsMainnetPlan = await mintSUsds(client, {
    chainId: CHAIN_ID_MAINNET,
    amount: hundredUsdc,
    sender: SENDER,
  });
  if (mintSusdsMainnetPlan.isErr()) throw mintSusdsMainnetPlan.error;
  console.log(describePlan(mintSusdsMainnetPlan.value));

  banner(`redeemUsds — USDS → USDC on Base`);
  const redeemUsdsQuote = await previewRedeemUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsds,
  });
  if (redeemUsdsQuote.isErr()) throw redeemUsdsQuote.error;
  console.log(`quote: ${formatToken(redeemUsdsQuote.value, 6, 'USDC')}`);
  const redeemUsdsPlan = await redeemUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: hundredUsds,
    sender: SENDER,
  });
  if (redeemUsdsPlan.isErr()) throw redeemUsdsPlan.error;
  console.log(describePlan(redeemUsdsPlan.value));

  banner(`redeemSUsds — sUSDS → USDC on Base`);
  const redeemSusdsQuote = await previewRedeemSUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: tenSusds,
  });
  if (redeemSusdsQuote.isErr()) throw redeemSusdsQuote.error;
  console.log(`quote: ${formatToken(redeemSusdsQuote.value, 6, 'USDC')}`);
  const redeemSusdsPlan = await redeemSUsds(client, {
    chainId: CHAIN_ID_L2,
    amount: tenSusds,
    sender: SENDER,
  });
  if (redeemSusdsPlan.isErr()) throw redeemSusdsPlan.error;
  console.log(describePlan(redeemSusdsPlan.value));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
