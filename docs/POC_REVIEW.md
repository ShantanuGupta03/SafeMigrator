# PoC review: findings and fix status

Scope: repository after the PoC hardening pass. Labels:

* **Confirmed bug** — code path verified; regression test where noted.
* **Suspected risk** — depends on wallet/RPC/user behavior.
* **Untested scenario** — no real-wallet evidence yet.

Status: **Fixed**, **Mitigated**, **Open**.

## P0: correctness and security

| # | Finding | Type | Status |
| --- | --- | --- | --- |
| 1 | Deselecting a network left stale assets in Signers/Review because Preview derived chains from raw `selectedAssetIds`. | Confirmed bug | **Fixed** — `effectiveSelection()` + `selection` in app state; Signers/Preview/discovery use it; deselect clears IDs via `withoutChain`. Tests: `tests/unit/selection.test.ts`. |
| 2 | Blocked networks dropped from migration record; completion implied full success. | Confirmed bug | **Fixed** — `MigrationScope`, `buildMigrationScope()`, partial ack on Review, `migrationOutcome()` on Complete, scope in receipt export. Tests: `tests/unit/migration-scope.test.ts`. |
| 3a | RPC/wallet errors after send treated as `failed` and blindly retried. | Confirmed bug | **Fixed** — `classifySubmissionError()`, `uncertain` + `submission_unknown`, `markUncertain()`. Tests: `tests/unit/submission-errors.test.ts`, execution resume tests updated. |
| 3b | Atomic batch fell back on any error, including ambiguous timeouts. | Confirmed bug | **Fixed** — fallback only when classification is `not_submitted`; ambiguous → `uncertain` + halt. |
| 3c | `awaiting_wallet` reset to `planned` on reload. | Confirmed bug | **Fixed** — `reconcileAwaitingWallet()` → `uncertain` unless onchain proof exists. |
| 3d | Dropped tx hash retryable while nonce still pending. | Confirmed bug | **Mitigated** — consumed nonce → `not_landed`; dropped hash with needs_attention is not auto-retryable (`isSafelyRetryable`). |
| 4a | `verifyTransfer` trusted any Safe balance increase. | Confirmed bug | **Mitigated** — receipt log check for ERC-20; native excess → `needs_attention`; evidence field on verification. |
| 4b | `prepareTransfers` marked verified on unrelated Safe deposit. | Confirmed bug | **Fixed** — removed “grew balance” shortcut; `alreadyInSafe` / `skipped` only. |
| 4c | Silent amount changes between Review and send. | Confirmed bug | **Fixed** — `amountsMateriallyChanged()` → `needs_attention` / `ACCEPT_AMOUNTS` path. |
| 5 | Owner verification trusted from localStorage only. | Confirmed bug | **Fixed** — `ownerProofs` on migration; `verifyStoredOwnerProof()` at execution via `validateMigrationOwnerProofs()`. |

## P1: robustness and public-demo hardening

| # | Finding | Type | Status |
| --- | --- | --- | --- |
| 6 | Tampered migration record (Safe address) | Suspected risk | **Mitigated** — execution re-validates proofs; transfers still require onchain Safe match. |
| 7 | RPC proxy without rate limits | Confirmed bug | **Fixed** — in-memory rate limit + body size cap on `/api/rpc/[chainId]`. |
| 8 | Discovery without rate limits | Confirmed bug | **Fixed** — rate limit on `/api/discovery`. |
| 9 | Stale preflight | Confirmed bug | **Fixed** — 30-minute freshness + selection key invalidates; Review blocks migrate when stale. |
| 10 | README vs milestones on public Sepolia run | Confirmed bug | **Mitigated** — README notes user-run Sepolia; milestones still require full Sepolia+Chiado evidence per [POC_VALIDATION.md](POC_VALIDATION.md). |
| 11 | “Complete” vs wallet retirement | Confirmed bug | **Fixed** — Complete copy + `migrationOutcome` distinguish partial/complete/uncertain. |

## Correction

Safe address negotiation uses **all environment testnets** in `useSafeTargets`, not only selected networks — deselecting a chain does **not** change the negotiated Safe version/address.

## Untested (needs human evidence)

* EIP-5792 batch on public testnet with MetaMask (or other) smart account.
* Full [POC_VALIDATION.md](POC_VALIDATION.md) checklist with two-owner Safe{Wallet} tx.
* WalletConnect / hardware-only owners on public networks.

## Test matrix (what we actually run)

| Flow | Evidence |
| --- | --- |
| Unit logic (selection, scope, submission class, planning, state machine) | `npm test` — mocks |
| Executor control flow | `npm test` — mocked wallet/RPC |
| Fork E2E (Sepolia + Chiado + batch executor) | `npm run test:fork` — real EVM, local fork |
| Live Safe address negotiation | `RUN_NETWORK_TESTS=1 npm run test:network` — live RPC reads |
| UI smoke | `npm run test:e2e` — read-only wallet mock |
| Public browser wallet migration | **Not automated** — follow POC_VALIDATION.md |
