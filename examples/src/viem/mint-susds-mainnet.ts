import { OseroClient, getChain } from '@osero/client';
/**
 * Mint sUSDS from USDC on Ethereum mainnet.
 *
 * Mainnet is the interesting case: there is no PSM3, so USDC has to
 * go through *two* contracts to reach sUSDS. The SDK models this as
 * a `MultiStepExecution` with four transactions:
 *
 *   phase 1:
 *     1. USDC.approve(UsdsPsmWrapper, amount)
 *     2. UsdsPsmWrapper.sellGem(sender, amount)       // sender gets USDS
 *   phase 2:
 *     3. USDS.approve(sUSDS, usdsOut)
 *     4. sUSDS.deposit(usdsOut, receiver)             // receiver gets sUSDS shares
 *
 * The viem adapter runs each step and waits for it to be mined
 * before starting the next one — `sendWith` handles the ordering.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples viem:mint-susds-mainnet
 *
 * WARNING: this targets Ethereum L1 and costs real gas.
 */
import { mintSUsds, previewMintSUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 1 as const;
const AMOUNT_USDC = parseUnits('25', 6);

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  const transport = http(optionalRpcUrl(CHAIN_ID));
  const wallet = createWalletClient({ account, chain: mainnet, transport });
  const client = OseroClient.create({ transports: { [CHAIN_ID]: transport } });

  banner(`mintSUsds — ${chainMeta.name} (${CHAIN_ID}) — MultiStepExecution`);
  console.log(`  sender: ${account.address}`);
  console.log(`  spend:  ${AMOUNT_USDC} USDC (raw 6-dec)`);

  const previewResult = await previewMintSUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
  });
  if (previewResult.isErr()) {
    console.error('previewMintSUsds failed:', previewResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(`  quote:  ${formatToken(previewResult.value, 18, 'sUSDS')}`);
  console.log('  note:   this is a 4-tx plan and will take ~4 blocks to settle');

  const result = await mintSUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
    sender: account.address,
  }).andThen(sendWith(wallet));

  if (result.isErr()) {
    console.error('mintSUsds failed:', result.error);
    process.exitCode = 1;
    return;
  }

  banner('Success');
  console.log(describeResult(result.value, chainMeta.explorerUrl));
  // `operations` here reads as:
  //   APPROVE_ERC20 → MINT_USDS → APPROVE_ERC20 → DEPOSIT_USDS_FOR_SUSDS
  // which is a nice audit trail.
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
