---
name: osero-sdk
description: 'Use the Osero SDK to build, inspect, and broadcast USDS/sUSDS mint and redeem transactions. USE WHEN writing code that imports `@osero/client`, `@osero/client/actions`, `@osero/client/viem`, or `@osero/client/ethers`. EXAMPLES: "mint USDS on Base", "redeem sUSDS with a viem wallet", "inspect the execution plan before sending", "wire this SDK into an ethers app".'
---

# Osero SDK

Use this skill when you need to write or review application code against this repository's published SDK.

## Package Surface

This SDK currently publishes one package: `@osero/client`.

Use these subpath exports:

- `@osero/client`
  - `OseroClient`
  - chain/token metadata helpers like `SUPPORTED_CHAIN_IDS`, `getChain`, `getToken`, `PSM_ADDRESSES`
  - balance helpers like `getTokenBalance`, `getTokenBalances`, `getUsdcBalance`, `getUsdsBalance`, `getSUsdsBalance`
  - plan helpers like `flattenExecutionPlan`, `isErc20ApprovalRequired`, `isMultiStepExecution`
  - error classes like `ValidationError`, `UnsupportedChainError`, `TransactionError`
- `@osero/client/actions`
  - `mintUsds`
  - `mintSUsds`
  - `redeemUsds`
  - `redeemSUsds`
- `@osero/client/viem`
  - `sendWith(walletClient)`
- `@osero/client/ethers`
  - `sendWith(signer)`

Do not invent other package names or import paths.

## Install

`viem` is always required as a peer dependency, even if the caller uses the ethers adapter.

```bash
pnpm add @osero/client viem

# Optional, only if using the ethers adapter:
pnpm add ethers
```

## Mental Model

The SDK separates transaction planning from transaction signing:

1. Create an `OseroClient`.
2. Call an action from `@osero/client/actions`.
3. The action returns `ResultAsync<ExecutionPlan, ActionError>`.
4. Either inspect that `ExecutionPlan` or pass it to an adapter with `sendWith(...)`.
5. The adapter executes every required transaction in order and returns `ResultAsync<TransactionResult, SendWithError>`.

This means:

- actions do not send transactions
- `OseroClient` does not hold a wallet
- adapters are the only layer that touches signing/broadcasting
- callers should usually write `await action(...).andThen(sendWith(walletOrSigner))`

## Supported Chains

The SDK supports these chain IDs:

- `1` Ethereum
- `10` OP Mainnet
- `130` Unichain
- `8453` Base
- `42161` Arbitrum One

Use `SUPPORTED_CHAIN_IDS` or `getChain(chainId)` instead of hard-coding chain metadata.

## Actions

Import actions from `@osero/client/actions`.

| Action        | Direction     | Input token decimals | Common plan shape                        |
| ------------- | ------------- | -------------------: | ---------------------------------------- |
| `mintUsds`    | USDC -> USDS  |                    6 | approval + swap                          |
| `mintSUsds`   | USDC -> sUSDS |                    6 | L2: approval + swap, Mainnet: multi-step |
| `redeemUsds`  | USDS -> USDC  |                   18 | approval + swap                          |
| `redeemSUsds` | sUSDS -> USDC |                   18 | L2: approval + swap, Mainnet: multi-step |

All actions accept this request shape:

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

Important request details:

- `amount` is always a raw `bigint` in the input token's native decimals
- `receiver` defaults to `sender`
- `slippageBps` defaults to `client.config.defaultSlippageBps`
- `referralCode` is relevant on L2 PSM3 routes

## Balance Reads

Import balance helpers from the root package when the caller only needs
read access to canonical token balances.

```ts
import {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
} from '@osero/client';
```

Use these helpers:

- `getTokenBalance(client, { chainId, account, token })` for one of
  the canonical Osero tokens: `USDC`, `USDS`, or `sUSDS`
- `getTokenBalances(client, { chainId, account })` to read all three
  balances together
- `getUsdcBalance`, `getUsdsBalance`, and `getSUsdsBalance` as thin
  convenience wrappers for the common single-token cases

All balance helpers return `ResultAsync<bigint, UnsupportedChainError |
UnexpectedError>` for single-token reads, or a keyed object of raw
`bigint` balances for `getTokenBalances`:

```ts
const balances = await getTokenBalances(client, {
  chainId: 8453,
  account: wallet.account.address,
});

if (balances.isOk()) {
  console.log(balances.value.USDC);
  console.log(balances.value.USDS);
  console.log(balances.value.sUSDS);
}
```

Balance helpers reuse the SDK's token registry and `OseroClient`
transport wiring, so prefer them over hand-written ERC-20 `balanceOf`
calls in application code and examples.

## Viem Usage

Use a viem wallet client with both `account` and `chain` configured.

```ts
import { OseroClient } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const rpcUrl = 'https://mainnet.base.org';
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

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

const result = await mintUsds(client, {
  chainId: 8453,
  amount: parseUnits('100', 6),
  sender: account.address,
}).andThen(sendWith(wallet));

if (result.isErr()) {
  console.error(result.error.name, result.error.message);
} else {
  console.log(result.value.txHash, result.value.operations);
}
```

Important viem notes:

- `sendWith(wallet)` throws synchronously if the wallet is missing `account` or `chain`
- the viem adapter estimates gas and adds a 15% buffer
- use `sendWith(wallet, { confirmations: 2 })` to wait for extra confirmations

## Ethers Usage

The ethers adapter uses an ethers v6 `Signer`, but `OseroClient` still needs viem transports for read calls.

```ts
import { OseroClient } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { http } from 'viem';

const rpcUrl = 'https://arb1.arbitrum.io/rpc';
const provider = new JsonRpcProvider(rpcUrl, 42161);
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);

const client = OseroClient.create({
  transports: {
    42161: http(rpcUrl),
  },
});

const sender = (await signer.getAddress()) as `0x${string}`;

const result = await mintUsds(client, {
  chainId: 42161,
  amount: parseUnits('100', 6),
  sender,
}).andThen(sendWith(signer));
```

Important ethers notes:

- the signer must already be connected to the target chain
- unlike viem, the ethers adapter does not switch chains for the caller
- a mismatched chain short-circuits with `UnexpectedError`

## Dry-Run And Plan Inspection

Inspect plans before signing if the caller needs a confirmation step.

```ts
import {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  OseroClient,
} from '@osero/client';
import { mintSUsds } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

const client = OseroClient.create({
  transports: {
    1: http('https://eth.llamarpc.com'),
  },
});

const planResult = await mintSUsds(client, {
  chainId: 1,
  amount: parseUnits('100', 6),
  sender: '0x1111111111111111111111111111111111111111',
});

if (planResult.isOk()) {
  const plan = planResult.value;

  if (isMultiStepExecution(plan)) {
    console.log('multi-step plan');
  }

  if (isErc20ApprovalRequired(plan)) {
    console.log('approval required before main transaction');
  }

  for (const tx of flattenExecutionPlan(plan)) {
    console.log(tx.operation, tx.to);
  }
}
```

Do not assume every action is a single transaction. Mainnet `sUSDS` flows can be multi-step.

## Error Handling

Plan-building errors commonly include:

- `ValidationError`
- `UnsupportedChainError`
- `InsufficientBalanceError`
- `UnexpectedError`

Execution errors commonly include:

- `CancelError`
- `SigningError`
- `TransactionError`
- `UnexpectedError`

Prefer checking `result.isErr()` and switching on `result.error.name`.

## Common Pitfalls

- Import actions from `@osero/client/actions`, not from the root package.
- Pass `amount` in raw token decimals, not human-readable numbers.
- Always `await` the full `ResultAsync` chain.
- Do not bind wallets to `OseroClient`; the client only handles reads and plan construction.
- When using ethers, still configure viem `http(...)` transports on `OseroClient`.
- Do not assume `txHash` covers every step. `TransactionResult.txHash` is the final transaction hash, while `operations` lists the full executed sequence.

## Useful Source References

When you need canonical usage in this repo, start with these files:

- `packages/client/README.md`
- `examples/src/dry-run/inspect-plan.ts`
- `examples/src/viem/mint-usds.ts`
- `examples/src/viem/redeem-susds.ts`
- `examples/src/ethers/mint-usds.ts`
