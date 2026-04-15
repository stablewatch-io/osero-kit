# `@osero/client`

The official TypeScript SDK for minting **USDS** and **sUSDS** on every
chain where Sky / Spark runs a PSM. One API, two wallet libraries
(**viem** and **ethers v6**), five chains out of the box.

---

## What it does

Given a wallet holding USDC, `@osero/client` builds and sends the
right sequence of transactions to land USDS or sUSDS in any address
you name, no matter which chain you are on:

| Chain        | Chain ID | Route                                               |
| ------------ | -------: | --------------------------------------------------- |
| Ethereum     |        1 | Spark `UsdsPsmWrapper` (+ ERC-4626 `sUSDS` deposit) |
| OP Mainnet   |       10 | Spark `PSM3`                                        |
| Unichain     |      130 | Spark `PSM3`                                        |
| Base         |     8453 | Spark `PSM3`                                        |
| Arbitrum One |    42161 | Spark `PSM3`                                        |

The SDK figures out which contract to talk to, reads the live fee
(`tin` / `tout`) or swap quote, assembles the approval and swap
transactions, and hands you back a wallet-agnostic `ExecutionPlan`
that either adapter can broadcast.

## Install

```bash
pnpm add @osero/client viem
# (optional) for the ethers adapter:
pnpm add ethers
```

`viem` is a required peer dependency — the SDK uses it to encode
calldata and to build public clients internally.
`ethers` is optional; install it only if you use
`@osero/client/ethers`.

## Quick start

### With viem

```ts
import { OseroClient } from '@osero/client';
import { mintSUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error('Set PRIVATE_KEY before sending transactions');

const client = OseroClient.create({
  transports: {
    8453: http('https://mainnet.base.org'),
  },
});

const wallet = createWalletClient({
  account: privateKeyToAccount(privateKey),
  chain: base,
  transport: http('https://mainnet.base.org'),
});

const result = await mintSUsds(client, {
  chainId: 8453,
  amount: parseUnits('100', 6), // 100 USDC
  sender: wallet.account.address,
}).andThen(sendWith(wallet));

if (result.isErr()) {
  console.error(result.error.name, result.error.message);
  return;
}

console.log('sUSDS minted in tx', result.value.txHash);
```

### With ethers v6

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
  amount: parseUnits('1000', 6),
  sender: await signer.getAddress(),
}).andThen(sendWith(signer));

if (result.isOk()) {
  console.log('USDS minted in tx', result.value.txHash);
}
```

## Actions

Every action returns a `ResultAsync<ExecutionPlan, …>` that you pipe
into `sendWith` (from either `@osero/client/viem` or
`@osero/client/ethers`) to execute.

| Action        | Direction    | Mainnet shape      | L2 shape            |
| ------------- | ------------ | ------------------ | ------------------- |
| `mintUsds`    | USDC → USDS  | approve + sellGem  | approve + PSM3 swap |
| `mintSUsds`   | USDC → sUSDS | four-tx two-phase  | approve + PSM3 swap |
| `redeemUsds`  | USDS → USDC  | approve + buyGem   | approve + PSM3 swap |
| `redeemSUsds` | sUSDS → USDC | three-tx two-phase | approve + PSM3 swap |

### Request shape

```ts
type Request = {
  chainId: number; // one of the supported chain IDs
  amount: bigint; // input amount in the input token's native decimals
  sender: `0x${string}`; // the wallet that pays the input
  receiver?: `0x${string}`; // default = sender
  slippageBps?: number; // default = client.config.defaultSlippageBps (5)
  referralCode?: bigint; // L2 only — emitted in the PSM3 `Swap` event
};
```

## Balance helpers

`@osero/client` also exposes read-only helpers for canonical token
balances so callers can stick with the SDK's chain registry and public
client wiring instead of dropping down to raw ERC-20 reads.

```ts
import {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
} from '@osero/client';
```

Choose the helper that matches the job:

- `getTokenBalance(client, { chainId, account, token })` reads one of
  the three canonical symbols: `USDC`, `USDS`, or `sUSDS`
- `getTokenBalances(client, { chainId, account })` returns all three
  balances in one keyed result object
- `getUsdcBalance`, `getUsdsBalance`, and `getSUsdsBalance` keep the
  common single-token cases terse

```ts
const result = await getTokenBalances(client, {
  chainId: 8453,
  account: wallet.account.address,
});

if (result.isOk()) {
  console.log(result.value.USDC);
  console.log(result.value.USDS);
  console.log(result.value.sUSDS);
}
```

All balance helpers return raw `bigint` values and surface
`UnsupportedChainError` or `UnexpectedError` through the same
`ResultAsync` model used by the action builders.

## Error handling

`@osero/client` uses [`neverthrow`](https://github.com/supermacro/neverthrow)
for functional error handling. Every action returns a
`ResultAsync`. Chain them with `.andThen`, then call `.isOk()` /
`.isErr()` at the top level:

```ts
const result = await mintUsds(client, request).andThen(sendWith(wallet));

if (result.isErr()) {
  switch (result.error.name) {
    case 'CancelError':
      // user rejected the wallet prompt
      break;
    case 'ValidationError':
      // bad input (amount <= 0, etc.)
      break;
    case 'UnsupportedChainError':
      // chainId is not in SUPPORTED_CHAIN_IDS
      break;
    case 'TransactionError':
      // tx was broadcast but reverted — inspect .txHash / .link
      break;
    case 'SigningError':
    case 'UnexpectedError':
      // RPC failure, bad signature, etc. — .cause has the original
      break;
  }
  return;
}
```

Every error class extends `OseroError`, which itself extends the
built-in `Error`, so `instanceof OseroError` is the broadest catch.

## Configuration

```ts
import { OseroClient } from '@osero/client';
import { http } from 'viem';

const client = OseroClient.create({
  // Override the default public transports for every chain you care
  // about — strongly recommended for production.
  transports: {
    1: http('https://eth.llamarpc.com'),
    10: http('https://mainnet.optimism.io'),
    130: http('https://mainnet.unichain.org'),
    8453: http('https://mainnet.base.org'),
    42161: http('https://arb1.arbitrum.io/rpc'),
  },

  // Default slippage (in bps) used by any action that doesn't pass
  // its own `slippageBps`. Defaults to 5 (= 0.05%).
  defaultSlippageBps: 10,
});
```

Set confirmation waits on the viem or ethers adapter when
broadcasting:

```ts
const result = await mintUsds(client, request).andThen(sendWith(wallet, { confirmations: 2 }));
```

## The execution plan model

Every action returns an `ExecutionPlan`, a wallet-agnostic
description of the transactions that need to happen. The adapter
(`sendWith`) is the only piece that touches a real wallet. This
gives you three things for free:

1. **Dry-run** — inspect the plan without signing anything:

   ```ts
   import { flattenExecutionPlan } from '@osero/client';

   const result = await mintSUsds(client, request);
   if (result.isOk()) {
     for (const tx of flattenExecutionPlan(result.value)) {
       console.log(tx.operation, tx.to, tx.data);
     }
   }
   ```

2. **Portability** — pass the same plan to a viem wallet, an ethers
   signer, a custom batching relayer, or an account-abstraction
   bundler. Only `sendWith` needs to change.
3. **Testability** — actions are pure functions over an `OseroClient`;
   unit-testing them without a live chain is a matter of injecting a
   mock `PublicClient`.

Plans come in three shapes:

- `TransactionRequest` — a single pre-encoded tx.
- `Erc20ApprovalRequired` — one or more approvals gating a single
  main tx (e.g. every L2 mint / redeem).
- `MultiStepExecution` — an ordered list of the above (e.g. mainnet
  sUSDS mint, which is USDC → USDS → sUSDS in two phases).

## Supported chains & contracts

All addresses live in the source tree in `src/lib/addresses.ts` and
`src/lib/tokens.ts`, and are re-exported from the package root:

```ts
import { SUPPORTED_CHAIN_IDS, CHAINS, PSM_ADDRESSES, getToken } from '@osero/client';

console.log(PSM_ADDRESSES[8453].psm); // Spark PSM3 on Base
console.log(getToken(1, 'sUSDS').address); // sUSDS on mainnet
```

## Building & testing

This package is part of the Osero SDK Nx workspace. From the repo
root:

```bash
pnpm nx build @osero/client      # tsc → dist/
pnpm nx typecheck @osero/client  # strict tsc --noEmit
pnpm nx test @osero/client       # vitest run
```

## License

MIT
