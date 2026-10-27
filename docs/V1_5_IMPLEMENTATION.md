# v1.5 implementation log

Working document for the v1.5 "migration workspace" release. It records the baseline, the plan,
decisions and what is (and is not) verified, so another engineer or agent can resume without
repeating the investigation. Keep it current.

Product goal: *Set up your multisig together, migrate across chains, and return whenever more
assets arrive.*

Reported history (not independently verified here): the project owner reports successful public
testnet migrations across Sepolia + Chiado and Sepolia + Base Sepolia + Chiado. No hashes were
attached, so they are recorded as user-reported runs only.

## Baseline (commit `30817a3`)

| Check | Result |
| --- | --- |
| `npm ci` | **Failed (pre-existing):** `package-lock.json` out of sync with `package.json`. `npm install` was used instead and the lockfile re-synced. |
| `npm test` | **Failed to start (pre-existing, Linux only):** `package.json` pins only `@rolldown/binding-darwin-arm64` as an optional dependency, so the Linux rolldown binding was missing. Fixed by adding `@rolldown/binding-linux-x64-gnu` to `optionalDependencies`. Then: 115 passed, 8 skipped (network/fork suites gated by env). |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass with 1 pre-existing warning (`useMemo` unused in `signers-screen.tsx`) |
| `npm run build` | Pass |
| `npm run test:network`, `npm run test:fork` | **Not runnable in this environment:** the sandbox network policy denies every public RPC host (HTTP 403 from the egress proxy for sepolia.drpc.org, rpc.chiadochain.net, publicnode, llamarpc). |

### Verified observations from the review

* `useSafeTargets` negotiates a Safe version over every chain of the environment, but
  `negotiateSafeVersion` silently drops chains whose RPC fails. With Chiado unreachable the common
  version flips from v1.3.0 to v1.4.1 and **the predicted address changes**. Confirmed in code.
* `runMigration` re-validates every owner proof with the client of the *first* execution chain.
  `verifyStoredOwnerProof` rejects a proof whose EIP-712 domain chain differs from the client, so a
  valid proof signed on another network pauses the run. Confirmed in code.
* The receipt is assembled inline in `CompleteScreen` (unversioned, no integrity commitment, mixes
  historical and live data).
* Draft, migration and history live in `localStorage` (`safe-migrator:v1:*`); there is no durable
  Safe identity separate from a run.

## Plan (delivery order)

1. **Safe profiles.** `src/lib/domain/profile.ts` (zod schemas), `src/lib/services/safe-profile.ts`
   (recipe, commitment, pinned target resolution, legacy recovery, export/import),
   `src/lib/state/profile-store.ts`. Pin the recipe when the user freezes a configuration (owner
   invites) or starts a run. Fix negotiation to treat unreachable RPCs as *indeterminate*.
2. **Owner invites.** EIP-712 v2 acknowledgement bound to the deployment commitment and a target-scope
   commitment; URL-fragment payload (deflate + base64url) with QR and file fallback; `/invite` page for
   co-owners; signed-response import with local nonce tracking; per-proof chain clients at execution.
3. **Receipts.** `src/lib/services/receipt.ts` (canonical model, JCS-style serialization, SHA-256),
   PDF via `pdf-lib`, `/receipt` inspector page.
4. **Add network.** Pinned-recipe extension with governance-divergence blocking; deployment-only runs
   through the existing engine.
5. **Late arrivals.** Per-profile watch state, new-asset detection, visible-only polling, sweep as a
   new linked run with governance review.
6. **Aave v3 beta.** Adapter interface + one adapter behind `NEXT_PUBLIC_ENABLE_AAVE_V3_BETA`, left
   disabled unless fork evidence exists.
7. **Readiness.** Readiness panel, outgoing-Safe-transaction evidence, Saved Safe screen, docs.

## Status

Progress is tracked per phase below; each section lists decisions, tests and open items.

_(updated as work proceeds)_
