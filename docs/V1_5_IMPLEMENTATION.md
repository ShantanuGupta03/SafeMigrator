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

## Test environments available here

* **Unit** (`npm test`): pure logic, mocked chain/wallet where stated in each file header.
* **Local canonical chains** (`npm run test:local`, `npm run test:e2e:local`): `scripts/local-chain.sh`
  starts three empty Hardhat chains with the Sepolia, Chiado and Base Sepolia chain IDs and installs
  the canonical Safe v1.3.0 runtime code at the canonical addresses (`tests/fixtures/safe-v1.3.0-runtime.json`,
  taken from `@gnosis.pm/safe-contracts@1.3.0`; each code hash is checked against
  `@safe-global/safe-deployments` before and after `hardhat_setCode`) plus Multicall3. This is real EVM
  execution with the real Safe bytecode, but **not** live-network state, so it is reported separately
  from public-testnet and fork evidence. It made the pre-existing fork suite runnable without public
  RPC access: 6/6 scenarios pass, including the EIP-7702 atomic batch.
* Playwright needs `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` in this sandbox (the bundled browser
  build for `@playwright/test@1.64.1` is not installed).

## Status

### Phase 1: saved Safe profiles (done)

* `src/lib/domain/profile.ts`: zod schemas (`SafeProfile`, `DeploymentRecipe`, snapshots, watch state,
  readiness record). `src/lib/services/safe-profile.ts`: recipe, commitment
  (`keccak256(abi.encode("safe-migrator/deployment-recipe/v1", derivation, version, "l2", factory,
  singleton, fallbackHandler, keccak256(initializer), saltNonce, keccak256(proxyCreationCode)))`),
  offline address derivation, `parseProfile` (re-derives commitment and address, rejects anything
  inconsistent), `resolvePinnedTarget`, legacy profiles and recovery, export/import, run linking.
  `src/lib/state/profile-store.ts`: per-entry validated storage; invalid entries are kept verbatim
  and reported, never repaired.
* Pinning: when the user freezes a configuration for owner verification (`proposed`) or starts a
  run (`active`). A pinned profile is used only when the draft reproduces its owners, threshold and
  salt exactly (`Draft.saltNonce` carries an imported salt). Pinned targets never renegotiate.
* Negotiation fix: an unreachable network now makes the version *indeterminate* (no address shown)
  instead of choosing from the reachable subset. `decideNegotiation` is the pure, tested step.
* Status `deployed_governance_changed`: a Safe at the pinned address whose owners or settings
  changed. CREATE2 binds the address to the original initializer, so any Safe there started with the
  original owners. Planning blocks it unless the user accepts the reviewed governance; the run then
  stores `ChainMigration.expectedGovernance` and the executor checks the live Safe against exactly
  that (`compareSafeToGovernance`). Production networks with changed governance stay blocked (owner
  proofs for current owners are not collected in v1.5).
* Legacy records: `needs_recovery` profiles without a recipe; "Recover from chain" or the next run with
  the same configuration re-derives and verifies the recipe against the recorded address on every
  recorded network. Mixed versions/addresses are refused and stay history-only.
* Hardening found on the way: sequential deployments now also check the CREATE2 target computed from
  the deployment calldata (previously only the batch path did); block-number reads in discovery,
  inspection and execution are uncached (`cacheTime: 0`). The cached read could make the
  pre-transfer Safe check read code at a block before the deployment and block transfers ("No
  contract code"); the local chains reproduced it deterministically.

### Phase 2: remote owner verification (done)

* `src/lib/services/owner-invites.ts`: EIP-712 domain `Safe Migrator Owner Verification` v2,
  `OwnerAcknowledgement{owner, safe, owners, threshold, deploymentCommitment, source, profileId,
  environment, targetChainIds, scopeCommitment, nonce, issuedAt, expiresAt, statement}`. Configuration
  identity = safe/owners/threshold/deploymentCommitment; invitation scope = the rest. Domain chainId
  = the network the owner signed on (ERC-1271 is checked there).
* Lifetimes: invitation 24 h default (1 h / 24 h / 72 h choices, 72 h max); the response must be
  imported before the invitation expires; an accepted proof is valid for execution for 7 days after
  issuance. Issuance more than 5 minutes in the future is rejected.
* Link: `/invite#i=<base64url(deflate-raw(json))>` (fragment never reaches a server), QR when the link
  is ≤ 1800 characters, invitation file otherwise/also. Co-owner page recomputes the commitment
  offline and the Safe address from the factory's creation code before enabling the sign button.
* Import: only for an invitation issued in this workspace (unknown nonce → rejected even with a valid
  signature), exact echo of the issued payload, before expiry, signature verified with a client for the
  response's own chain. Duplicate import is a no-op. Revoke and configuration changes invalidate.
  Nonce registry is local to the stored workspace (documented in UI and here).
* Legacy v1 challenges: still re-verified for runs created before v1.5 (24 h rule, now with a client
  for the proof's own chain); in the draft they no longer count and the UI asks to verify again.
* Execution: owner readiness is checked per chain inside `runChain` after reconciliation, each proof
  with a client for its own domain chain. Contract-wallet proofs count only on their own chain. On
  testnets problems are logged, never blocking (verification is optional there, as before).
* Tests: `tests/unit/owner-invites.test.ts` (18), `tests/e2e/owner-invite.spec.ts` (two isolated
  browser contexts on local canonical chains: tampered response rejected, verification, idempotent
  re-import, no transaction requested by either wallet).
