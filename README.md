# Osero SDK

TypeScript SDK for building and sending USDS and sUSDS mint/redeem transactions across
Sky/Spark PSM deployments. It supports viem and ethers v6 wallets, returns typed
`neverthrow` results, and exposes wallet-agnostic execution plans that can be inspected
before anything is signed.

## Features

- Mint USDS from USDC and redeem USDS back to USDC.
- Mint sUSDS from USDC and redeem sUSDS back to USDC.
- Preview exact-in output amounts before building or sending a plan.
- Supports Ethereum mainnet, OP Mainnet, Unichain, Base, and Arbitrum One.
- Uses viem internally for ABI encoding and public RPC reads.
- Provides adapters for `@osero/client/viem` and `@osero/client/ethers`.

## Installation

Install the SDK with viem:

```bash
pnpm add @osero/client viem
```

If you use the ethers adapter, install ethers v6 as well:

```bash
pnpm add @osero/client viem ethers
```

With npm:

```bash
npm install @osero/client viem
npm install ethers # optional, only for @osero/client/ethers
```

## Quick Start With viem

```ts
import { OseroClient } from '@osero/client';
import { mintSUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const rpcUrl = 'https://mainnet.base.org';
const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error('Set PRIVATE_KEY before sending transactions');

const account = privateKeyToAccount(privateKey);

const client = OseroClient.create({
  transports: {
    8453: http(rpcUrl),
  },
});

const wallet = createWalletClient({
  account,
  chain: base,
  transport: http(rpcUrl),
});

const result = await mintSUsds(client, {
  chainId: 8453,
  amount: parseUnits('100', 6), // 100 USDC
  sender: account.address,
}).andThen(sendWith(wallet));

if (result.isErr()) {
  console.error(result.error.name, result.error.message);
  process.exit(1);
}

console.log('sUSDS minted:', result.value.txHash);
```

## Quick Start With ethers

```ts
import { OseroClient } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet, parseUnits } from 'ethers';

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('Set PRIVATE_KEY before sending transactions');

const provider = new JsonRpcProvider('https://arb1.arbitrum.io/rpc');
const signer = new Wallet(privateKey, provider);
const client = OseroClient.create();

const result = await mintUsds(client, {
  chainId: 42161,
  amount: parseUnits('100', 6), // 100 USDC
  sender: await signer.getAddress(),
}).andThen(sendWith(signer));

if (result.isOk()) {
  console.log('USDS minted:', result.value.txHash);
} else {
  console.error(result.error.name, result.error.message);
}
```

## Inspect a Plan Without Sending

Actions return an `ExecutionPlan` first. You can inspect that plan before sending it to
a wallet adapter:

```ts
import { OseroClient, flattenExecutionPlan } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

const client = OseroClient.create({
  transports: {
    8453: http('https://mainnet.base.org'),
  },
});

const planResult = await mintUsds(client, {
  chainId: 8453,
  amount: parseUnits('25', 6),
  sender: '0x1111111111111111111111111111111111111111',
});

if (planResult.isOk()) {
  for (const tx of flattenExecutionPlan(planResult.value)) {
    console.log(tx.operation, tx.to);
  }
}
```

The repository also includes a dry-run script:

```bash
pnpm install
pnpm --filter @osero/examples dry-run:inspect-plan
```

## Preview a Flow Before Sending

Preview helpers mirror the exact-in action names and return the quoted
output amount as a `ResultAsync<bigint, ...>`. They only need
`chainId` and `amount` because they do not build a sender-specific
plan:

```ts
import { previewMintSUsds } from '@osero/client/actions';
import { parseUnits } from 'viem';

const quote = await previewMintSUsds(client, {
  chainId: 8453,
  amount: parseUnits('100', 6),
});

if (quote.isOk()) {
  console.log('expected sUSDS out:', quote.value);
}
```

## Available Actions

Import actions from `@osero/client/actions`:

```ts
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
```

| Action        | Direction     | Input decimals |
| ------------- | ------------- | -------------: |
| `mintUsds`    | USDC -> USDS  |              6 |
| `mintSUsds`   | USDC -> sUSDS |              6 |
| `redeemUsds`  | USDS -> USDC  |             18 |
| `redeemSUsds` | sUSDS -> USDC |             18 |

Matching preview helpers:

| Helper               | Quotes        | Input decimals |
| -------------------- | ------------- | -------------: |
| `previewMintUsds`    | USDC -> USDS  |              6 |
| `previewMintSUsds`   | USDC -> sUSDS |              6 |
| `previewRedeemUsds`  | USDS -> USDC  |             18 |
| `previewRedeemSUsds` | sUSDS -> USDC |             18 |

Every action accepts:

```ts
type ActionRequest = {
  chainId: number;
  amount: bigint;
  sender: `0x${string}`;
  receiver?: `0x${string}`;
  slippageBps?: number;
  referralCode?: bigint;
};
```

## Balance Helpers

Import balance helpers from the root package when you want raw token
balances without wiring ERC-20 calls yourself:

```ts
import {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
} from '@osero/client';
```

Use `getTokenBalance(client, { chainId, account, token })` for a
single canonical token, `getTokenBalances(client, { chainId, account })`
to read `USDC`, `USDS`, and `sUSDS` together, or the convenience
wrappers for common single-token reads.

```ts
const balances = await getTokenBalances(client, {
  chainId: 8453,
  account: account.address,
});

if (balances.isOk()) {
  console.log(balances.value.USDC);
  console.log(balances.value.sUSDS);
}

const susds = await getSUsdsBalance(client, {
  chainId: 8453,
  account: account.address,
});
```

These helpers return `ResultAsync` values and reuse the SDK's
supported-chain checks, token registry, and configured public
transports.

## Configuration

Create an `OseroClient` once and pass it to action functions:

```ts
import { OseroClient } from '@osero/client';
import { http } from 'viem';

const client = OseroClient.create({
  transports: {
    1: http('https://eth.llamarpc.com'),
    10: http('https://mainnet.optimism.io'),
    130: http('https://mainnet.unichain.org'),
    8453: http('https://mainnet.base.org'),
    42161: http('https://arb1.arbitrum.io/rpc'),
  },
  defaultSlippageBps: 5,
});
```

Set confirmation waits on the adapter when broadcasting:

```ts
const result = await mintUsds(client, request).andThen(sendWith(wallet, { confirmations: 2 }));
```

## Supported Chains

| Chain        | Chain ID |
| ------------ | -------: |
| Ethereum     |        1 |
| OP Mainnet   |       10 |
| Unichain     |      130 |
| Base         |     8453 |
| Arbitrum One |    42161 |

You can also read chain and token metadata from the SDK:

```ts
import { SUPPORTED_CHAIN_IDS, getChain, getToken } from '@osero/client';

console.log(SUPPORTED_CHAIN_IDS);
console.log(getChain(8453)?.name);
console.log(getToken(8453, 'USDC').address);
```

## Examples

Runnable examples live in `examples/src`.

The dry-run script and broadcast examples now show the preview helpers
alongside plan building so you can compare the expected output quote
with the eventual balance delta.

## Releases

This repo uses Changesets for independent package versioning.

```bash
pnpm changeset
```

When a change affects a publishable package in `packages/*`, add a changeset in the same
PR. After merge to `main`, the release workflow opens or updates a version PR. Merging
that PR publishes the changed public packages to npm.

```bash
cp examples/.env.example examples/.env
# Edit examples/.env and replace PRIVATE_KEY before running broadcast examples.

pnpm --filter @osero/examples viem:mint-usds
pnpm --filter @osero/examples viem:redeem-susds
pnpm --filter @osero/examples ethers:mint-usds
pnpm --filter @osero/examples ethers:roundtrip
```

The examples broadcast real transactions. Use a disposable wallet with small balances
and explicit RPC URLs when testing against public networks.

## Development

```bash
pnpm install
pnpm nx build @osero/client
pnpm nx typecheck @osero/client
pnpm nx test @osero/client
pnpm lint
pnpm format:check
```

The SDK source is in `packages/client/src`. Tests are colocated as `*.test.ts`, and
Vitest coverage is written to `packages/client/test-output/vitest/coverage`.

## License

MIT
