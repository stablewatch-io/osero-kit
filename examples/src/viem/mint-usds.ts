import { OseroClient, getChain } from '@osero/client';
/**
 * Mint USDS from USDC on Base using a viem wallet.
 *
 * Flow on L2:
 *   1. USDC.approve(PSM3, amount)
 *   2. PSM3.swapExactIn(USDC, USDS, amount, minOut, receiver, 0)
 *
 * The SDK returns an `Erc20ApprovalRequired` plan; the viem adapter
 * walks the approvals in order and then broadcasts the swap.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples viem:mint-usds
 */
import { mintUsds, previewMintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('10', 6); // 10 USDC

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  // The viem wallet client must have both `account` and `chain`
  // pinned — the `sendWith` adapter relies on both to set `from`
  // and `chainId` on every tx, and throws synchronously otherwise.
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(optionalRpcUrl(CHAIN_ID)),
  });

  // `OseroClient` reuses the same transport for its read calls
  // (PSM3 previewSwapExactIn, LitePSM tin/tout, etc.).
  const client = OseroClient.create({
    transports: {
      [CHAIN_ID]: http(optionalRpcUrl(CHAIN_ID)),
    },
  });

  banner(`mintUsds — ${chainMeta.name} (${CHAIN_ID})`);
  console.log(`  sender: ${account.address}`);
  console.log(`  spend:  ${AMOUNT_USDC} USDC (raw 6-dec)`);

  const previewResult = await previewMintUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
  });
  if (previewResult.isErr()) {
    console.error('previewMintUsds failed:', previewResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(`  quote:  ${formatToken(previewResult.value, 18, 'USDS')}`);

  // Curried form — `sendWith(wallet)` is a plan → ResultAsync handler
  // that fits right into `.andThen`. This is the canonical way to
  // call the SDK when you already know you want to broadcast.
  const result = await mintUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
    sender: account.address,
  }).andThen(sendWith(wallet));

  if (result.isErr()) {
    console.error('mintUsds failed:', result.error);
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
