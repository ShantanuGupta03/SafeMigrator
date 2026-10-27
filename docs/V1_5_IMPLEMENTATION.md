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

### Phase 3: receipts, PDF, inspector (done)

* `src/lib/services/receipt.ts`: one canonical, zod-validated model (`safe-migrator/receipt` v1) used by
  the JSON export, the PDF and the inspector. `record` (historical, frozen) and `currentState`
  (labelled live re-read at export) are separate; a live re-read never changes `record` (tested).
  Raw base units (`plannedRaw`, `reviewedRaw`, `verifiedDeltaRaw`, `loggedRaw`, `sourceRemainingRaw`)
  are kept apart from derived display strings. Missing history is `null`/`unknown`, never inferred.
  Excluded by design: private labels, raw owner signatures, the debug log.
* Integrity: `sha256-jcs-v1` = SHA-256 over canonical JSON (sorted keys, no whitespace, safe integers
  only, `undefined` rejected) of the receipt without `integrity`. Test vectors were computed
  independently with Python `hashlib`. The inspector hashes the file's own JSON (not a normalized
  copy), so added fields or a changed letter case are detected.
* PDF: `src/lib/services/receipt-pdf.ts` (pdf-lib, standard fonts, A4, paginated, outcome banner,
  exceptions before details, explorer links + QR per network, receipt hash on every page footer).
  Visually inspected at 70 dpi (single-page partial run; 10-page run with 83 transactions and long
  reasons). `pypdf` text extraction confirmed the hash, source and every transaction hash in both PDFs
  match the JSON.
* `/receipt`: offline inspector (schema + hash), no requests on load (asserted in
  `tests/e2e/receipt.spec.ts`), optional explicit "Recheck onchain" through the read-only proxy, PDF
  only for receipts whose hash matches.
* Build provenance: `NEXT_PUBLIC_BUILD_COMMIT` / `NEXT_PUBLIC_APP_VERSION` injected by `next.config.ts`
  (unknown stays `null`). `/invite` is served with `Referrer-Policy: no-referrer`.

### Phase 4: add a network to a saved Safe (done)

* `src/lib/services/chain-extension.ts` (`assessExtension`, `applyAssessment`) +
  `src/components/add-network-panel.tsx` on the Saved Safes screen.
* Uses only the pinned recipe (`resolvePinnedTarget`): canonical code hashes on the target network,
  factory creation-code hash, offline CREATE2 address = recorded address, Protocol Kit cross-check,
  then inspection of the address. Outcomes: deploy (nothing there), reuse (matching original
  configuration, recorded without a transaction), blocked (changed configuration at the address,
  foreign contract, incompatible network, unreadable network).
* Governance: every known deployment is re-read first; any change from the original owners,
  threshold or security settings, or any read failure, blocks routine extension with an explanation
  (the recipe would install the ORIGINAL owners). No owner synchronisation in v1.5; the user can
  create a separate Safe through the normal flow. Fresh observations are stored per network.
* Deployment-only runs reuse the normal planner/executor (`purpose: "extension"`), so gas reserve,
  simulation, receipt tracking, reconciliation and post-deployment verification all apply; the
  panel shows the wallet confirmations and the gas reserve.
* Evidence (local canonical chains, `tests/integration/local-chain.test.ts`): create on Sepolia →
  reload + export/import → extend to Chiado at the same address; reuse of a third-party deployment on
  Base Sepolia; divergence (threshold changed via storage) blocks; conflicting contract blocks;
  network without the pinned singleton is `incompatible` with no renegotiation; tampered recipe
  rejected.

### Phase 5: late arrivals and reviewed sweeps (done)

* `src/lib/services/late-arrivals.ts` (pure) + `src/components/late-arrivals-panel.tsx`.
* Identity = discovery asset ID (chain, standard, contract, token ID). A finished linked run records
  handled assets (`withHandledFromMigration`, called from `syncProfileWithMigration`): migrated items
  at what stayed behind, native gas dust kept on purpose (`retained`) at the reviewed balance,
  excluded selections at their amount. They resurface only on a meaningful increase (≥ 5%, and for
  native ≥ 0.001 of the coin). "Ignore" adds an `ignored` baseline. Suspicious assets are never
  surfaced (counted as hidden).
* Scans: `error` changes nothing but the check record; `partial` may add/update but never removes;
  only `ok` removes items no longer held. Last-checked time and per-network coverage are shown.
* Triggers: manual "Check for new assets"; a rescan when the Saved Safes page is opened and the last
  check is older than 10 minutes; optional polling every 15/30/60 minutes only while the tab is
  visible (stops on hide/unmount, no overlapping scans, at most 24 automatic checks per page
  session). The UI says plainly that nothing is monitored after the app is closed.
* "Review sweep" links the draft to the profile, selects the chosen transferable arrivals, rescans
  them and goes through Portfolio → Signers → Review as a NEW run (`purpose: "sweep"`). Nothing from
  the check is reused for planning; balances, simulations, governance and owner proofs are evaluated
  again. Changed governance needs explicit acceptance (Phase 1). No unattended signing exists.
* Evidence: `tests/unit/late-arrivals.test.ts` (5) and the sweep scenario in
  `tests/integration/local-chain.test.ts` (new ERC-20 + NFT detected after a run, reload, failed scan
  keeps them, sweep without redeployment (2 transactions, no factory call), quiet afterwards).
* Not implemented: vesting/unclaimed entitlements are not detected as arrivals (no protocol
  integration); closed-browser monitoring and notifications are out of scope.

### Phase 6: Aave v3 supply-position beta (implemented, DISABLED, fork evidence missing)

* Interface: `src/lib/services/protocols/types.ts` (`enrich`, `recheck`, `interpretVerification`),
  registry `src/lib/services/protocols/index.ts`. Extension points for Compound v2/III, LP and staked
  positions are documented there; none are implemented.
* Adapter: `src/lib/services/protocols/aave-v3.ts`, behind `NEXT_PUBLIC_ENABLE_AAVE_V3_BETA`
  (default `false`). Markets: Aave v3 Sepolia, Base Sepolia, Ethereum Core, Base. Core addresses
  were taken from the raw `bgd-labs/aave-address-book` files (`src/AaveV3*.sol`, main branch) during
  implementation; re-verify before enabling.
* Identification: provider → `getPool`/`getPoolDataProvider` must equal the registry; reserve list →
  `getReserveTokensAddresses` → aToken map; each candidate aToken must confirm `POOL()` and
  `UNDERLYING_ASSET_ADDRESS()`. Names and symbols are ignored (look-alike tokens stay specialized).
* Risk: `getUserAccountData(source).totalDebtBase` for the whole pool must be exactly 0; debt or any
  read failure keeps the position specialized. Rechecked in `prepareTransfers` immediately before
  submission (blocks with `needs_attention`), after which the exact transfer is simulated as usual.
  No approvals: the plain ERC-20 transfer adapter moves the aToken.
* Accrual/rounding: received amount may be up to 2 base units below what was sent, or above it by
  accrual (≤ 0.01% of the Safe's prior balance + 2). Anything outside stays
  `verified_with_discrepancy`. Late-arrival baselines for these positions sit 0.1% above the
  remainder, so ongoing interest alone does not alert. Incentive rewards stay with the source.
* Evidence: `tests/unit/aave-adapter.test.ts` (6, mocked reads only). `tests/integration/aave-fork.test.ts`
  (`npm run test:fork:aave`) covers debt-free success, debt refusal, debt appearing after review,
  unknown debt, spoofed metadata, paused reserve and accrual against the real Sepolia deployment.
  **It has not been run**: this environment cannot reach any Sepolia RPC to fork from. Until it
  passes, the beta must stay disabled; nothing in the app enables it by default.

### Phase 7: readiness, UX integration, acceptance (done)

* `src/lib/services/readiness.ts` + `src/components/readiness-panel.tsx`: deployment/settings per
  network, owners with proven key control vs each network's *current* threshold, native gas in the
  Safe, and outgoing-transaction evidence. Evidence is accepted only for a successful transaction
  with an `ExecutionSuccess` log emitted by this Safe on that chain (threshold read at the block
  before); deposits, other Safes' executions and wrong-network hashes are rejected (local-chain test
  with a real 2-of-3 `execTransaction`). Manual acknowledgement is stored and shown separately.
* Saved Safes screen (header "Saved Safes"): identity, per-network governance with age/staleness,
  readiness, late arrivals, add network, export/import, legacy recovery, private label.
* Fixes found by the full-UI test: concurrent panels overwrote each other's profile updates (now
  `updateProfile(id, fn)` on the latest stored profile); a sweep onto a network where the Safe was not
  deployed skipped the divergence rule (Review now blocks it via `deploymentBlocked`); the header
  button had no accessible name on mobile.

## Final status

### Commands and results (this environment)

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass (the pre-existing unused-import warning was removed) |
| `npm test` | 179 passed, 23 skipped (network/fork/local suites are env-gated) |
| `npm run build` | pass (routes `/`, `/invite`, `/receipt`, `/testnet`, API routes) |
| `npm run test:local` | 13 passed: the 6 original fork scenarios (incl. EIP-7702 batch) + 7 saved-Safe scenarios, on local canonical chains |
| `npm run test:e2e:local` (with `PW_CHROMIUM_PATH`) | 14 passed (desktop + mobile): smoke, receipt inspector, two-browser owner verification, full workspace flow |
| `npm run test:network` | **not run**: public RPCs are blocked by this sandbox's network policy |
| `npm run test:fork`, `npm run test:fork:aave` | **not run against real forks** for the same reason (the fork *scenarios* ran on local canonical chains instead; Aave cannot, it needs Aave's deployed state) |

Mocked or simulated evidence is labelled in each test file header. Local canonical chains are real
EVM execution with the real Safe bytecode, but not live-network state, indexers or wallets.

### Skipped or unverified, with reasons

* Live-network reads and forks (network policy). Re-run `npm run test:network` and `npm run test:fork`
  where public RPCs are reachable.
* Aave v3 beta against deployed Aave contracts: not run; the flag stays `false`.
* Real wallets (MetaMask, Rabby, hardware, ERC-1271 contract wallets) for owner acknowledgements and
  sweeps: not exercised; mocks were used in Playwright.
* Public-testnet v1.5 checklist (`docs/POC_VALIDATION.md`): needs a human with wallets.

### Remaining limitations

* Saved Safes, invitations and watch state are per browser (export to move them); no relay, no
  closed-browser monitoring or notifications (out of scope).
* Changed governance is tracked but never synchronised; production networks with changed governance
  are blocked because proofs for later-added owners are not collected.
* Per-network different Safe versions (different addresses) cannot be part of one saved Safe; such
  networks are blocked at Review with an explanation.
* Late arrivals rely on the same discovery as v1 (indexer + known tokens + manual imports); vesting
  or unclaimed entitlements are not detected.
* Receipts' integrity hash is a commitment, not a signature; onchain attestations are out of scope
  (the commitment is suitable for a later opt-in design).

### Manual test sequence (short)

1. `npm run build && npm run start`; on `/` connect a funded testnet EOA; select two networks.
2. Signers: 3 owners, 2-of-3 → "Freeze configuration" → "Invite" owner 2 → open the link in another
   browser profile, sign, copy the response → paste on device 1 → Verified.
3. Review → Migrate → Complete → download Receipt (JSON, PDF) → open `/receipt`, paste the JSON.
4. Saved Safes → Check readiness → Add network (third network) → Deploy.
5. Send a token to the source → Check for new assets → Review sweep → migrate (no redeployment).
6. Execute a small Safe transaction in Safe{Wallet}; paste its hash in readiness → Observed.

### Repository state

All work is committed locally on branch `claude/festive-curie-yxncfe`. Nothing has been pushed,
published or deployed (per instructions).
