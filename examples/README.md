# @osero/examples

Runnable examples for `@osero/client`. Each file is a self-contained
script that previews a flow, builds an `ExecutionPlan`, and either
inspects it or broadcasts it through a wallet adapter.

## Layout

```
src/
├── shared/            Helpers reused by every example
│   ├── env.ts         Loads PRIVATE_KEY + RPC URLs from process.env
│   └── format.ts      Pretty-printing + small logging helpers
├── dry-run/
│   └── inspect-plan.ts        Build a plan without sending it. No funds needed.
├── viem/
│   ├── mint-usds.ts           USDC → USDS on Base (single approve + swap)
│   ├── mint-susds-mainnet.ts  USDC → sUSDS on Ethereum mainnet (MultiStepExecution)
│   ├── redeem-susds.ts        sUSDS → USDC on Base
│   └── roundtrip-usdc-susds.ts  USDC → sUSDS → USDC, full round-trip on Base
└── ethers/
    ├── mint-usds.ts           Same as viem/mint-usds.ts but through an ethers v6 Wallet
    └── roundtrip-usdc-susds.ts  Full round-trip on Base through ethers
```

## Running

```bash
# From the repo root
pnpm install
cp examples/.env.example examples/.env
# Edit examples/.env — at minimum set PRIVATE_KEY

# Dry-run (no funds, no tx): prints the ExecutionPlan the SDK would produce.
pnpm --filter @osero/examples dry-run:inspect-plan

# viem examples
pnpm --filter @osero/examples viem:mint-usds
pnpm --filter @osero/examples viem:mint-susds-mainnet
pnpm --filter @osero/examples viem:redeem-susds
pnpm --filter @osero/examples viem:roundtrip

# ethers examples
pnpm --filter @osero/examples ethers:mint-usds
pnpm --filter @osero/examples ethers:roundtrip
```

> **The examples broadcast real transactions** against whichever RPC
> you configure. Use a disposable wallet funded with small amounts,
> and double-check the chain ID and amounts printed at the top of
> each script before confirming.

## The mental model in ~40 lines

The SDK splits "what to do" from "how to sign":

1. **Action functions** (`mintUsds`, `mintSUsds`, `redeemUsds`,
   `redeemSUsds`) live under `@osero/client/actions`. Matching
   preview helpers (`previewMintUsds`, `previewMintSUsds`,
   `previewRedeemUsds`, `previewRedeemSUsds`) return the quoted output
   amount for the same exact-in amount on a chain. The action
   functions themselves take an `OseroClient` + a request object and
   return a `ResultAsync<ExecutionPlan, ActionError>`.
2. **`ExecutionPlan`** is a wallet-agnostic description of the work.
   It is a discriminated union of:
   - `TransactionRequest` — a single ready-to-send tx
   - `Erc20ApprovalRequired` — approvals then a main tx
   - `MultiStepExecution` — multiple phases, each depending on the
     previous one landing on-chain
3. **Adapters** (`@osero/client/viem`, `@osero/client/ethers`)
   expose a `sendWith(wallet)` that walks the plan, broadcasts every
   tx in order, and returns a `TransactionResult` or a typed error.

The roundtrip examples also show the read side of the SDK: they use
preview helpers to print expected output amounts up front, then use
`getTokenBalances` and `getSUsdsBalance` from `@osero/client` to track
the balance delta across the mint and redeem legs without hand-writing
ERC-20 `balanceOf` calls.

That dichotomy is the whole SDK — everything else is routing per
chain. On L2s the plans are `Erc20ApprovalRequired` (PSM3 swap). On
Ethereum mainnet, minting or redeeming sUSDS becomes a
`MultiStepExecution` because USDC has to go through two contracts
(Sky's `UsdsPsmWrapper` and then the ERC-4626 sUSDS vault).

## Why `.andThen(sendWith(wallet))`?

Every action returns a `ResultAsync` from
[neverthrow](https://github.com/supermacro/neverthrow). The curried
form of `sendWith` is itself a function
`(plan) => ResultAsync<TransactionResult, SendWithError>`, which
means you can pipe it directly:

```ts
const result = await mintUsds(client, request).andThen(sendWith(wallet));

if (result.isErr()) {
  console.error(result.error); // typed union: ValidationError | SigningError | …
  return;
}
console.log(result.value.txHash); // final tx hash
console.log(result.value.operations); // e.g. ['APPROVE_ERC20', 'MINT_USDS']
```

If you prefer to inspect the plan before sending, call the adapter
directly with the unwrapped plan (see `dry-run/inspect-plan.ts`).
