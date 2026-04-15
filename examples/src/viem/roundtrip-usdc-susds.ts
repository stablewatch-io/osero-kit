import { OseroClient, getChain, getSUsdsBalance, getTokenBalances } from '@osero/client';
/**
 * Full round-trip on Base using a viem wallet:
 *
 *   USDC → sUSDS (mintSUsds)  → sUSDS → USDC (redeemSUsds)
 *
 * Between the two swaps the script reads sUSDS balance to compute
 * exactly how many shares to burn, so you end with (approximately)
 * the same USDC you started with minus PSM3 fees and gas. Before
 * running, make sure the signer is funded with USDC on Base.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples viem:roundtrip
 */
import {
  mintSUsds,
  previewMintSUsds,
  previewRedeemSUsds,
  redeemSUsds,
} from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const MINT_AMOUNT_USDC = parseUnits('10', 6); // 10 USDC in

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  const transport = http(optionalRpcUrl(CHAIN_ID));
  const wallet = createWalletClient({ account, chain: base, transport });
  const client = OseroClient.create({ transports: { [CHAIN_ID]: transport } });

  const balancesBeforeResult = await getTokenBalances(client, {
    chainId: CHAIN_ID,
    account: account.address,
  });
  if (balancesBeforeResult.isErr()) throw balancesBeforeResult.error;
  const { USDC: usdcBefore, sUSDS: susdsBefore } = balancesBeforeResult.value;

  banner(`Round-trip — ${chainMeta.name}`);
  console.log(`  sender: ${account.address}`);
  console.log(
    `  start:  ${formatToken(usdcBefore, 6, 'USDC')}, ${formatToken(susdsBefore, 18, 'sUSDS')}`,
  );

  if (usdcBefore < MINT_AMOUNT_USDC) {
    console.error(`  insufficient USDC: have ${usdcBefore}, need ${MINT_AMOUNT_USDC}`);
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------
  // Leg 1 — USDC → sUSDS
  // -------------------------------------------------------------
  banner('Leg 1 — mintSUsds');
  const mintPreview = await previewMintSUsds(client, {
    chainId: CHAIN_ID,
    amount: MINT_AMOUNT_USDC,
  });
  if (mintPreview.isErr()) throw mintPreview.error;
  console.log(`  quote:    ${formatToken(mintPreview.value, 18, 'sUSDS')}`);

  const mintResult = await mintSUsds(client, {
    chainId: CHAIN_ID,
    amount: MINT_AMOUNT_USDC,
    sender: account.address,
  }).andThen(sendWith(wallet));

  if (mintResult.isErr()) {
    console.error('mintSUsds failed:', mintResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(describeResult(mintResult.value, chainMeta.explorerUrl));

  // How many sUSDS shares did we actually receive? Read the delta
  // from the balance — this is more robust than decoding logs.
  const susdsMidResult = await getSUsdsBalance(client, {
    chainId: CHAIN_ID,
    account: account.address,
  });
  if (susdsMidResult.isErr()) throw susdsMidResult.error;
  const susdsMid = susdsMidResult.value;
  const sharesReceived = susdsMid - susdsBefore;
  console.log(`  received: ${formatToken(sharesReceived, 18, 'sUSDS')}`);

  // -------------------------------------------------------------
  // Leg 2 — sUSDS → USDC
  // -------------------------------------------------------------
  banner('Leg 2 — redeemSUsds');
  const redeemPreview = await previewRedeemSUsds(client, {
    chainId: CHAIN_ID,
    amount: sharesReceived,
  });
  if (redeemPreview.isErr()) throw redeemPreview.error;
  console.log(`  quote:    ${formatToken(redeemPreview.value, 6, 'USDC')}`);

  const redeemResult = await redeemSUsds(client, {
    chainId: CHAIN_ID,
    amount: sharesReceived,
    sender: account.address,
  }).andThen(sendWith(wallet));

  if (redeemResult.isErr()) {
    console.error('redeemSUsds failed:', redeemResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(describeResult(redeemResult.value, chainMeta.explorerUrl));

  // -------------------------------------------------------------
  // Final delta
  // -------------------------------------------------------------
  const balancesAfterResult = await getTokenBalances(client, {
    chainId: CHAIN_ID,
    account: account.address,
  });
  if (balancesAfterResult.isErr()) throw balancesAfterResult.error;
  const { USDC: usdcAfter, sUSDS: susdsAfter } = balancesAfterResult.value;

  banner('Round-trip complete');
  console.log(
    `  end:   ${formatToken(usdcAfter, 6, 'USDC')}, ${formatToken(susdsAfter, 18, 'sUSDS')}`,
  );
  // USDC delta is negative in the common case — PSM3 fees on each
  // leg plus a tiny sliver of yield from holding sUSDS for a few
  // seconds. Don't expect it to be exactly zero.
  console.log(`  Δusdc: ${usdcAfter - usdcBefore} (raw 6-dec)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
