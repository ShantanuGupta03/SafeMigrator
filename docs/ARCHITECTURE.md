# Safe Migrator — Architecture

Safe Migrator is a **noncustodial transaction orchestration interface**. It never holds keys,
never becomes a Safe owner, and every state-changing operation is authorized by the user's own
wallet. The application's job is to (1) discover what the EOA holds, (2) compute a deterministic
Safe configuration (2-of-3 by default, user-adjustable), (3) deploy that Safe with official contracts, (4) move assets into it,
and (5) prove — by reading the chain — what actually happened.

```
 ┌──────────────────────────── Browser (Next.js client) ────────────────────────────┐
 │                                                                                   │
 │  UI screens (Connect → Discover → Signers → Preview → Progress → Complete)        │
 │        │                                                                          │
 │        ▼                                                                          │
 │  AppStateProvider (migrationReducer + ref mirror + localStorage persistence)      │
 │        │                                                                          │
 │        ▼                                                                          │
 │  MigrationExecutionService ── orchestrates per chain, sequentially ──┐            │
 │     │            │              │                 │                  │            │
 │     ▼            ▼              ▼                 ▼                  ▼            │
 │  SafeDeploy-  AssetTransfer  TransactionCap-  GasEstimation   OnchainVerification │
 │  mentService  Service        abilityService   Service         Service             │
 │     │  (Protocol Kit)          (EIP-5792)                                         │
 │     ▼                                                                             │
 │  ChainRegistryService ── public clients ──► /api/rpc/[chainId] (read-only proxy)  │
 │  WalletConnectionService ── wagmi / EIP-1193 ──► user's wallet (all signatures)   │
 │  AssetDiscoveryService ── /api/discovery ──► indexer (Blockscout / Alchemy)       │
 │                         └─ RPC re-verification of every indexed balance           │
 └───────────────────────────────────────────────────────────────────────────────────┘
 ┌──────────── Next.js server routes (no signing keys, ever) ─────────────┐
 │ /api/rpc/[chainId]   allow-listed read-only JSON-RPC proxy; hides keys  │
 │ /api/discovery       indexer adapter; hides indexer API keys            │
 └─────────────────────────────────────────────────────────────────────────┘
```

## Service map

| Service | File | Responsibility |
| --- | --- | --- |
| WalletConnectionService | `src/lib/services/wallet-connection.ts` | Detect wallet type (EOA, EIP-7702-delegated EOA, contract wallet), enforce source account + chain ID before every write. |
| ChainRegistryService | `src/lib/chains/registry.ts` | Typed network registry, environment gating, explorers, Safe{Wallet} prefixes, confirmation depth. |
| AssetDiscoveryService | `src/lib/services/discovery/*` | Indexer adapters + RPC verification + manual imports + classification + spam heuristics. |
| SignerConfigurationService | `src/lib/services/signer-configuration.ts` | Validate, dedupe, sort owners; ENS resolution; config hash. |
| OwnershipVerificationService | `src/lib/services/ownership-verification.ts` | EIP-712 owner-control challenges (EOA + ERC-1271/6492 via viem). |
| SafeDeploymentService | `src/lib/services/safe-deployment.ts` | Version negotiation, verified contract overrides, Protocol Kit prediction, deployment tx generation, independent CREATE2 cross-check. |
| OnchainVerificationService | `src/lib/services/onchain-verification.ts` | Read owners, threshold, singleton, modules, guard, fallback handler; balance/ownership checks. |
| GasEstimationService | `src/lib/services/gas-estimation.ts` | Fee data, per-action gas, OP-stack L1 fees, native reserve, dust policy. |
| TransactionCapabilityService | `src/lib/services/transaction-capability.ts` | `wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus` parsing. |
| MigrationPlanningService | `src/lib/services/migration-planning.ts` | Builds deterministic actions per chain, confirmation counts, blockers. |
| AssetTransferService | `src/lib/services/asset-transfer.ts` | Encodes + simulates native/ERC-20/721/1155 transfers; post-transfer verification. |
| MigrationExecutionService | `src/lib/services/migration-execution.ts` | Runs the plan, handles rejection/failure, reconciliation and resume. Checks owner readiness per chain and destination governance before transfers. |
| SafeProfileService (v1.5) | `src/lib/services/safe-profile.ts`, `src/lib/domain/profile.ts`, `src/lib/state/profile-store.ts` | Saved Safes: pinned deployment recipe + commitment, pinned per-chain resolution, legacy recovery, export/import, run linking. |
| OwnerInviteService (v1.5) | `src/lib/services/owner-invites.ts`, `owner-readiness.ts` | EIP-712 v2 owner acknowledgements, invitation links/files, signed-response import with a local nonce registry, execution-time re-verification per proof chain. |
| ReceiptService (v1.5) | `src/lib/services/receipt.ts`, `receipt-pdf.ts` | Canonical receipt model, canonical JSON + SHA-256 commitment, PDF rendering, offline inspection. |
| ChainExtensionService (v1.5) | `src/lib/services/chain-extension.ts` | "Add network" assessment from the pinned recipe; governance-divergence blocking. |
| LateArrivalService (v1.5) | `src/lib/services/late-arrivals.ts` | Watch state per saved Safe: handled baselines, new/increased assets, scan folding that never treats failure as "gone". |
| ReadinessService (v1.5) | `src/lib/services/readiness.ts` | Observed/acknowledged/unknown readiness checks; outgoing Safe transaction evidence. |
| Protocol adapters (v1.5) | `src/lib/services/protocols/*` | Adapter interface; Aave v3 supply-position beta (disabled by default). |

## Key design decisions

### 1. Deterministic Safe configuration (see `docs/SAFE_DEPLOYMENT.md`)
* Owners are checksummed, deduplicated and **sorted ascending** so entry order never changes the address.
* `saltNonce` is explicit. Protocol Kit's default salt nonce is chain-specific
  (`keccak256(PREDETERMINED_SALT_NONCE + chainId)`), which would break cross-chain address parity.
* `isL1SafeSingleton: false` is forced. Protocol Kit defaults to the L1 singleton on Ethereum mainnet
  and the L2 singleton elsewhere, which would also break parity.
* The Safe version is negotiated across the environment's networks: we pick the newest version whose
  **canonical** singleton, proxy factory and fallback handler exist on every chain with the exact
  `codeHash` published in `@safe-global/safe-deployments`. On Sepolia + Gnosis Chiado + Base Sepolia that is **v1.3.0**
  (Chiado has no v1.4.1 deployment); on the production networks it is **v1.4.1**.
* Verified addresses are passed to Protocol Kit as `contractNetworks` so the SDK cannot silently
  pick a different deployment type (e.g. the `eip155` v1.3.0 set on Sepolia).
* The address returned by Protocol Kit is cross-checked against an independent CREATE2 computation
  (viem + `proxyCreationCode()` read from the factory). The generated deployment calldata is decoded and
  rejected if it contains a setup delegatecall, modules, payment or an unexpected fallback handler.

### 2. Two-stage execution
Deploy → verify (owners, threshold, singleton, no modules, no guard, expected fallback handler) → transfer.
Assets are **never** sent to a merely predicted address.

### 3. Capability-aware batching (see `docs/BATCHING.md`)
Per chain: if `wallet_getCapabilities` reports `atomic.status` of `supported` or `ready`, all transfers on
that chain are submitted in one `wallet_sendCalls` with `atomicRequired: true`; otherwise transactions
are sent sequentially. Batches never span chains. Deployment is always its own transaction.

### 4. Idempotent, end-state intents
Every action is an *intent about end state* ("the Safe holds token X / NFT #7"), identified by a
deterministic ID: `chainId:kind:contract[:tokenId]`. Before any (re)send the executor re-reads chain
state: deployed Safe → skip deploy; NFT already owned by Safe → mark confirmed; ERC-20 balance now zero → skip.
Submitted transaction hashes / EIP-5792 call IDs are persisted *before* waiting, so an interrupted
session reconciles via receipts instead of re-sending. Pending-nonce checks prevent sending while a
previous transaction from the source EOA is still in the mempool.

### 5. State model (`src/lib/state/*`, `src/components/app-state.tsx`)
`Migration → ChainMigration[] → Action[]`, each with explicit statuses and a validated transition table.
There is no global success boolean; completion is derived from per-action verified results.

* `AppStateProvider` holds the migration reducer. Every event is applied **synchronously** to a ref, so
  the executor always reads the latest state, and is mirrored into React state for rendering. Each
  change is persisted to `localStorage` under `safe-migrator:v1:migration:<source>`. The draft
  (selection, signers, owner verifications, manual imports) is stored separately.
* `useRunner` (`src/components/hooks/use-runner.ts`) is a module-level single-run guard. Two tabs'
  worth of clicks, StrictMode double effects or a Resume during a run can never start a second
  executor. Pause sets a stop flag that the executor checks between actions.
* The executor depends only on ports: `WalletPort` (wagmi in the app; a viem wallet in fork tests;
  a mock in unit tests), `clientFor(chainId)`, `dispatch` and `getMigration`. That is what lets the same
  code run in the browser, on forks and under mocks.

### 6. Discovery selection policy
`isAutoSelectable` decides what *Select all transferable* may pick (transferable only).
`isPreselectable` is stricter: it covers what is ticked by default on first load, which is native
balances, known-list tokens, manual imports and priced assets. Unpriced long-tail tokens are visible
but start unticked, and suspicious assets are collapsed behind a "Review" toggle.

### 7. Secrets and environments
* RPC and indexer credentials live only in server env vars and are used by `/api/rpc` and `/api/discovery`.
* Production-network **execution** requires `NEXT_PUBLIC_ENABLE_MAINNET_EXECUTION=true`, the chain listed
  in `NEXT_PUBLIC_MAINNET_EXECUTION_CHAINS`, and at least `threshold` owners verified by signature.
  Discovery on production networks is always allowed.

### 8. Testnet tools
`/testnet` deploys the precompiled sample contracts (`src/lib/testnet/artifacts.json`, built from
`contracts/TestAssets.sol`) from the user's wallet. It records them under
`safe-migrator:v1:testnet-assets:<account>` and adds them to the draft's manual imports so discovery
re-reads them. The page is only linked when the environment is testnet.

### 9. Saved Safes and the migration workspace (v1.5)
A `SafeProfile` is the durable identity; a `Migration` is one run linked to it by `profileId` and
`deploymentCommitment`. The profile's recipe is pinned when the configuration is frozen for owner
verification or a run starts, and from then on every network is resolved from the recipe alone
(`resolvePinnedTarget`): no negotiation, and RPC failures are reported as unknown instead of
"incompatible". Governance is tracked per network as observations (`GovernanceSnapshot`); a Safe
whose owners changed is `deployed_governance_changed`, sending to it needs explicit acceptance of the
observed state (stored as `expectedGovernance` and re-checked by the executor), and deploying the
recipe on a new network is blocked while any known deployment diverges or cannot be read. Profile
updates from concurrent async work go through `updateProfile(id, fn)`, which applies `fn` to the
latest stored profile. Everything is in `localStorage`; nothing about profiles, invitations or
receipts leaves the browser except files the user downloads.

## Test layers

| Layer | Location | What it proves |
| --- | --- | --- |
| Unit | `tests/unit` | Pure logic and executor control flow, with mocked wallet and chain |
| Live read-only | `tests/integration/safe-prediction.test.ts` (`npm run test:network`) | Canonical contracts, version negotiation and address parity on real Sepolia, Chiado and Base Sepolia |
| Fork end to end | `tests/integration/fork-migration.test.ts` (`npm run test:fork`) | The production planning and executor path deploys real Safes and moves real tokens on forked chains |
| UI | `tests/e2e` (`npm run test:e2e`) | Screens render and connect with real RPC reads; the RPC proxy refuses broadcasts |
| Local canonical chains | `scripts/local-chain.sh` (`npm run test:local`, `npm run test:e2e:local`) | Real EVM and the canonical Safe v1.3.0 bytecode at canonical addresses on empty Hardhat chains (no public RPC): the fork scenarios, saved-Safe workflows, two-device verification and the full UI flow. Not live-network state. |

## Directory layout

```
src/app/                 Pages (/, /testnet) + API routes (/api/rpc/[chainId], /api/discovery)
src/components/          App state provider, hooks (runner, Safe targets), screens, UI primitives
src/lib/chains/          Chain registry, execution gate, RPC policy, clients
src/lib/domain/          Core types, amount math (BigInt only)
src/lib/server/          Server-only indexer adapters
src/lib/services/        Service layer (pure where possible, injected clients)
src/lib/state/           State machine, reducer, persistence
src/lib/testnet/         Compiled sample-asset artifacts
contracts/               Testnet-only sample tokens (ERC-20/721/1155 + edge cases)
scripts/                 Contract compilation, screenshots, fork test runner
tests/unit|integration|e2e
docs/                    Architecture, deployment mechanics, batching, security, testnet guide
```
