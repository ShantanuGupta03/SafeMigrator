# Security model, assumptions and limitations

Safe Migrator is a **transaction orchestration interface, not a custodian**. This document lists
what it guarantees, what it relies on, and what has not been validated yet.

## Guarantees enforced in code

| # | Requirement | How it is enforced |
| --- | --- | --- |
| 1 | Noncustodial | All writes go through the user's wallet (`WalletPort` → wagmi). The server routes cannot sign: `/api/rpc` forwards only an allow-list of read methods and returns 403 for `eth_sendRawTransaction`, `eth_sign`, `personal_*` and `wallet_*` (unit test + Playwright test). |
| 2 | No seed phrases or private keys | No UI accepts them. Nothing secret is persisted: localStorage holds only migration progress, addresses, tx hashes and owner-challenge signatures (which authorize nothing). |
| 3 | The app is never an owner | Owners come only from user input; there is no app signer. The deployment calldata is decoded and must match an owners/threshold-only `setup`. |
| 4, 5 | Official Safe contracts only | Canonical addresses come from `@safe-global/safe-deployments`, and each contract's `codeHash` is verified onchain before use. Deployment uses Protocol Kit. No custom implementation exists. |
| 6 | No delegatecall, modules, guards or unlimited approvals | The setup `to`/`data` must be empty. A deployed Safe with modules or a guard counts as a mismatch. ERC-20 uses `transfer`, never `approve`. |
| 7 | Simulation | Before every write there is an `eth_call` plus `eth_estimateGas` in the preview, and again just before sending. A failing simulation excludes the asset or stops the action. |
| 8 | Explicit confirmation | The preview shows destination per network, owners, threshold, networks, assets, fees, strategy and confirmation count. A review checkbox is required before *Migrate to Safe*. |
| 9 | No transfer to an unverified Safe | Sequential: transfers start only after `compareSafeToConfig` returns zero issues, re-run when resuming. Atomic batch: the deployment is the batch's first call, and its CREATE2 address (recomputed from the checked calldata) must equal the transfers' target, so the transfers revert unless that exact Safe is created. The Safe is verified right after, before the native transfer. |
| 10 | Chain-ID validation | The RPC chain ID is checked during prediction and discovery. The wallet's chain ID and account are checked before each send (`WrongChainError`, `WrongAccountError`). |
| 11 | No replayable authorizations | Owner acknowledgements (v1.5, EIP-712 domain version 2) bind the owner, the full owner list and threshold, the pinned deployment commitment, the Safe address, source, profile, environment, target networks (+ scope commitment), a random 32-byte nonce, `issuedAt` and `expiresAt`. Responses are accepted only for invitations issued in the same workspace, before expiry, once; issuance more than 5 minutes in the future is rejected. Accepted proofs count for execution for 7 days. They authorize nothing onchain and are never used as spending authorization. Legacy v1 challenges remain verifiable for pre-v1.5 runs only. |
| 12 | EIP-7702 is not a Safe | Delegated EOAs are labelled as such. Delegation is never offered as a substitute for migration. |
| 13 | No silent spam transfers | Suspicious assets are excluded from Select all and hidden by default. Selecting one requires an explicit choice. |
| 14 | Credentials server-side | `RPC_URL_*`, `ALCHEMY_API_KEY` and `ASSET_INDEXER` have no `NEXT_PUBLIC_` prefix and are read only in route handlers. |
| 15 | Resumable without replay | Hashes and call IDs are persisted before waiting. Resume reconciles from receipts and onchain end state. A pending-nonce guard and a single-run guard prevent duplicates. Verified on forks: a session killed after submission resumes without resending. |

Additional measures:
* Production-network execution is gated three ways: the build flag `NEXT_PUBLIC_ENABLE_MAINNET_EXECUTION`,
  the per-chain allow-list `NEXT_PUBLIC_MAINNET_EXECUTION_CHAINS`, and at least `threshold` owners
  verified by signature. The executor re-checks the gate at runtime, not just the UI.
* Security headers: `X-Frame-Options: DENY` (prevents clickjacking of wallet prompts), `nosniff`,
  a strict referrer policy and a restrictive permissions policy.
* Amounts are BigInt end to end, and gas and fee safety margins are configurable.

### v1.5 additions

| Property | How it is enforced |
| --- | --- |
| Destination cannot drift | A saved Safe's deployment recipe is pinned and re-derived on every load (`parseProfile`): commitment and CREATE2 address are recomputed, canonical contract addresses and the setup initializer are checked. Pinned networks never renegotiate the version; an unreachable network is "unknown", not "incompatible". For new configurations an unreachable network leaves the version undecided instead of choosing from a subset. |
| Untrusted local and imported data | Profiles, profile files, invitation payloads, signed responses, invitation records and receipts are parsed with size limits and runtime schemas (addresses, chain IDs within the environment, enums, timestamps, commitments). Corrupted stored profiles are reported and never repaired or used. Imported governance observations are discarded; every action re-reads the chain. |
| Proofs checked on the right network | Each stored proof is re-verified with a client for the network its EIP-712 domain names. A contract-wallet (ERC-1271) proof counts only on that network. |
| Governance changes are never papered over | A Safe whose owners or settings changed is never reused silently: sending to it needs acceptance of the observed state, which the executor re-checks exactly before transfers; production networks stay blocked. Deploying the recipe on another network is blocked while any known deployment diverged or cannot be read, both from "Add network" and from Review. |
| Every deployment targets the verified address | Sequential deployments now also recompute the CREATE2 target from the deployment calldata (previously only batched deployments did). |
| Fresh state after writes | Block numbers are read uncached in discovery, inspection and execution, so a check right after a deployment cannot read code at a stale block. |
| Receipts are commitments, not certificates | SHA-256 over canonical JSON; the inspector hashes the file's own JSON (added fields or changed case are detected). Loading a receipt performs no network request; "Recheck onchain" is explicit and only reads supported networks through the read-only proxy. Receipts exclude private labels, owner signatures and the debug log. |
| No unattended activity | Late-arrival checks only read; polling runs only while the tab is visible, never overlaps, and is bounded. A sweep is a new reviewed run that the user signs step by step. |
| Protocol positions | Off by default. The Aave v3 beta identifies aTokens only through registry-backed protocol reads, requires zero (and readable) debt in the pool, and re-checks immediately before submission. |

## Trust assumptions

* **The user's wallet** displays transactions faithfully and signs only what the user approves.
* **RPC providers** return honest state. Reads are taken at a single block and cross-checked
  where possible, but a malicious RPC could misreport balances or code. Use a provider you trust for
  production. For high-value migrations, compare results with a second provider.
* **`@safe-global/safe-deployments` and Protocol Kit** are authentic. This is mitigated by onchain
  `codeHash` verification and an independent CREATE2 computation.
* **Indexers** are only candidate lists. Every shown balance is re-read onchain, but an indexer can
  *miss* assets. Coverage is stated per network, and manual import exists for anything missing.
* **The hosting origin** serves the code you expect. As with any dapp, a compromised frontend could
  propose different transactions. Wallets that decode calldata are the user's final check.

## Known limitations

* **Owner verification** proves control of an address at signing time. Co-owners can verify from
  their own device through an invitation link, but the link itself does not authenticate the sender:
  co-owners are told to confirm the owner list out of band. The nonce registry is local to the
  initiator's browser workspace, not global. Proofs do not show that owners are different people,
  devices or seed phrases.
* **Saved Safes, invitations and watch state live in one browser's localStorage.** Clearing site
  data loses them (export profiles to keep them). Nothing is monitored after the app is closed.
* **Changed governance** (owners added/removed after deployment) is tracked per network but never
  synchronised; v1.5 cannot collect owner proofs for owners that were added later, so production
  networks with changed governance are blocked.
* **Fee-on-transfer and rebasing tokens** are detected after the fact, as a balance discrepancy.
  They are not prevented. Rebasing balances can drift between preview and execution; the executor
  uses the live balance at send time.
* **Positions** in lending, staking, LP or vesting contracts are not unwound. Recognised receipt
  tokens are classified as specialized, and the rest may be missed by indexers.
* **Approvals** granted by the old EOA remain in place. The completion screen recommends reviewing them.
* **The source EOA as owner.** If the user keeps the source EOA as one of the three owners, the Safe
  is still a multisig, but that key's exposure history carries over. The app warns about this.
* **Pricing** is approximate and only shown when the indexer provides it. It is never used for
  amounts.
* **EIP-5792 batching** is verified on a fork with an EIP-7702 test wallet, but has not been
  validated with a real wallet's batching yet (see `BATCHING.md`). With batching, the Safe deployment
  and token transfers share one atomic transaction. Requirement 9 then holds through atomicity plus a
  CREATE2 address check rather than a check between two transactions.
* **Custom thresholds.** Any 1–10 owners and threshold are allowed. 1-of-N (one stolen key empties
  the Safe) and N-of-N (one lost key locks it forever) need an explicit acknowledgment.
* **The sample contracts** in `contracts/` are unaudited and only for testnets.

## Production-network validation checklist

Complete every item before setting `NEXT_PUBLIC_ENABLE_MAINNET_EXECUTION=true` for any chain.

1. [ ] Run `npm run test:network` against **production** RPCs. Confirm v1.4.1 is negotiated and the
       predicted address matches an independent computation on every chain you plan to enable.
2. [ ] Run `npm run test:fork` against forks of the target mainnets, adapting the fork URLs and
       the chain list, using small amounts of real tokens from impersonated holders.
3. [ ] Do a full manual testnet run with the production build and your intended wallet(s). Test
       sequential mode and, if used, EIP-5792 mode, plus a rejection, a resume and a top-up retry.
4. [ ] Configure dedicated RPC endpoints (`RPC_URL_<chainId>`) and an indexer key. Confirm
       nothing secret appears in `.next/static` (`rg -l <key> .next/static` must return nothing).
5. [ ] Verify two independent owners by signature in the UI, and confirm Safe{Wallet} shows the
       expected owners and threshold after a testnet run.
6. [ ] Have someone else review this repository, especially `safe-deployment.ts`,
       `migration-execution.ts` and `asset-transfer.ts`.
7. [ ] Enable chains one at a time through `NEXT_PUBLIC_MAINNET_EXECUTION_CHAINS`, starting with a
       low-value migration.
