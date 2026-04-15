import { OseroClient, getChain } from '@osero/client';
/**
 * Mint USDS from USDC on Base using an ethers v6 signer.
 *
 * Identical semantics to `viem/mint-usds.ts` — the only thing that
 * changes is the wallet adapter subpath. This is the whole point of
 * the `ExecutionPlan` split: the action itself has no idea whether
 * it will eventually be broadcast through viem, ethers, or a smart
 * account abstraction.
 *
 * Note: the ethers adapter does *not* hot-switch chains. The signer
 * must already be connected to the target chain, or `sendWith` will
 * short-circuit with an `UnexpectedError`.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples ethers:mint-usds
 */
import { mintUsds, previewMintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet } from 'ethers';
import { http, parseUnits } from 'viem';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('10', 6);

async function main() {
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  // The ethers signer has to be on the right chain up-front — the
  // adapter verifies `signer.provider.getNetwork()` against the
  // plan's `chainId` and errors out if they disagree.
  const provider = new JsonRpcProvider(
    optionalRpcUrl(CHAIN_ID) ?? 'https://mainnet.base.org',
    CHAIN_ID,
  );
  const signer = new Wallet(loadPrivateKey(), provider);

  // `OseroClient` still needs a viem transport for its own read
  // calls. Plug the same RPC URL into `http(...)` and everything
  // works.
  const client = OseroClient.create({
    transports: {
      [CHAIN_ID]: http(optionalRpcUrl(CHAIN_ID)),
    },
  });

  const senderAddress = (await signer.getAddress()) as `0x${string}`;

  banner(`mintUsds — ${chainMeta.name} (ethers)`);
  console.log(`  sender: ${senderAddress}`);
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

  const result = await mintUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
    sender: senderAddress,
  }).andThen(sendWith(signer));

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
