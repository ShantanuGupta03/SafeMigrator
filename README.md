# Safe Migrator

> **Disclaimer — read first**
>
> Safe Migrator is an **independent proof-of-concept**. It is **not affiliated with, endorsed by, or maintained by Safe{Wallet}, Safe Labs, or any Safe product team**. It has **not** been security-audited, is **not** running in production as an official service, and **production-network execution is off by default**. Automated tests and local forks do not replace a formal audit or mainnet validation. Use **testnets** for demos unless you explicitly enable mainnet and accept the risks in [docs/SECURITY.md](docs/SECURITY.md).

**Move the assets in an existing wallet (EOA) into a multi-signature Safe (2-of-3 by default) on several EVM networks, from one guided flow — then keep using it as a workspace: set the multisig up together, add networks, and return whenever more assets arrive.**

Safe Migrator connects your wallet and discovers what it holds on each supported network. It then
helps you choose the owners and threshold, predicts the Safe address (the same address on every compatible
network), deploys the Safe with the official Safe contracts, transfers the selected assets and
verifies the result onchain. It is a **noncustodial orchestration interface**: your wallet signs
every action, the app holds no keys, and it never becomes a Safe owner.

> One migration intent, not one transaction. The preview screen tells you exactly how many wallet
> confirmations, network switches and transactions each network needs before you start.

| Connect | Discover | Choose signers | Preview |
| --- | --- | --- | --- |
| ![Connect](docs/screenshots/connect.png) | ![Discover](docs/screenshots/discover.png) | ![Signers](docs/screenshots/signers-filled.png) | ![Preview](docs/screenshots/preview.png) |

Screenshots are regenerated from a production build (`node scripts/screenshots.mjs`) with a read-only
mock wallet against live testnet RPCs. They show Sepolia, Gnosis Chiado and Base Sepolia on Portfolio,
configurable signers, and Review preflight from real `eth_estimateGas` simulations. Regenerate after UI
changes so the README stays accurate.

---

## Status

### New in v1.5 (migration workspace)

Details, decisions and evidence: [docs/V1_5_IMPLEMENTATION.md](docs/V1_5_IMPLEMENTATION.md).

* **Saved Safes.** Each Safe keeps a pinned, versioned *deployment recipe* (version, factory,
  singleton, fallback handler, exact initializer, salt, proxy creation code) with a commitment hash.
  Later runs, sweeps and new networks reuse it verbatim; the Safe version is never renegotiated and an
  unreachable network can no longer change the address. Profiles are stored locally, validated on
  load, and can be exported/imported (tampered files are rejected). Pre-v1.5 records become
  "needs recovery" profiles that are only upgraded after the recipe is re-derived from chain state.
* **Remote co-owner verification.** Freeze the configuration, send each co-owner an invitation link
  (or QR / file). They review the full owner list and recomputed Safe address on their own device,
  sign an EIP-712 acknowledgement (no transaction, no funds) and send the signed response back to
  paste in. No server relays anything; nonces, expiry, revocation and configuration changes are
  enforced locally. Proofs are re-checked at execution on the network they were signed on.
* **Versioned receipts.** One canonical receipt model for JSON, PDF and an offline inspector
  (`/receipt`), with a SHA-256 integrity commitment over canonical JSON. Historical facts and later
  live re-reads are kept apart; partial and uncertain runs are labelled as such.
* **Add network.** Deploy a saved Safe on another network at the same address, or record a matching
  Safe already there. Blocked whenever governance changed on a known network (the recipe would
  install the original owners) or a network cannot be read.
* **Late arrivals and sweeps.** "Check for new assets" (plus a rescan on return and optional polling
  while the tab is visible) lists new or meaningfully increased holdings; a sweep is a new, fully
  reviewed run into the saved Safe, with no redeployment where the Safe exists.
* **Safe readiness.** Observed-vs-acknowledged checks: deployment and settings per network, owners
  with proven key control against the current threshold, gas in the Safe, and an outgoing
  threshold-signed Safe transaction (accepted only from the Safe's own `ExecutionSuccess` event).
* **Aave v3 supply positions (beta, disabled by default).** Registry-verified aTokens of a debt-free
  source can be moved as plain transfers. Not enabled until `npm run test:fork:aave` has passed; it
  has not been run yet.

### Implemented and tested (v1)
* **Wallet connection** through EIP-6963 injected wallets (MetaMask, Rabby, Coinbase Wallet, Frame, …)
  and, optionally, WalletConnect. The app detects a plain EOA, an EIP-7702-delegated EOA, or a contract wallet.
* **Multichain discovery.** Native balances come from RPC. ERC-20, ERC-721 and ERC-1155 holdings come
  from an indexer (Blockscout by default, Alchemy optional) and are then **re-read onchain** at a single
  block. The app also checks a known-token list and supports manual token/NFT import.
  * Assets are classified as transferable, specialized, non-transferable, unsupported or suspicious;
    spam heuristics hide likely scam tokens by default.
  * RPC and indexer failures are reported per network; they are never treated as "zero balance".
* **Signer setup.** 2-of-3 by default; add or remove owners (1–10) and pick any threshold.
  Addresses are validated, ENS is resolved, duplicates are rejected and owners are sorted
  deterministically. 1-of-N and N-of-N need an explicit risk acknowledgment, and the app warns when
  the source EOA stays an owner.
* **Owner verification** by EIP-712 signature (EOAs, plus contract wallets via ERC-1271/6492). Each
  challenge is single-use, expires after 10 minutes and is bound to the Safe configuration hash.
* **Deterministic Safe addresses** via Safe Protocol Kit, cross-checked by an independent CREATE2
  computation. The Safe version is negotiated so Sepolia, Chiado and Base Sepolia get the **same address**
  (v1.3.0); see [docs/SAFE_DEPLOYMENT.md](docs/SAFE_DEPLOYMENT.md).
* **Existing-Safe detection.** A matching Safe already at the predicted address is reused. A mismatching
  contract blocks that network.
* **Deploy, verify, then transfer.** One-by-one, the app verifies the owners, threshold, singleton,
  modules, guard and fallback handler onchain before any asset moves. In an atomic batch, the
  deployment is the first call and the transfers revert unless it creates exactly the expected Safe.
* **Transfer adapters:**
  * Native transfers go last, after reserving gas.
  * ERC-20 uses `transfer` with live balances and no approvals.
  * ERC-721 uses `safeTransferFrom`.
  * ERC-1155 uses `safeTransferFrom` / `safeBatchTransferFrom`.
  * Every transfer is simulated first and verified afterwards by balance or ownership reads, so
    fee-on-transfer tokens show up as discrepancies.
* **Gas management.** Per-network estimates for deployment and transfers, including the OP-stack L1
  data fee. The app blocks deficits, keeps a native reserve and applies a dust policy. All amounts are
  BigInt; the margins are configurable.
* **Execution engine.** A typed state machine tracks per-action intents. Hashes are persisted before
  the app waits for them, so an interrupted session reconciles from receipts instead of re-sending.
  You can Resume, Retry failed actions or Pause. A pending-nonce guard and a single-run guard
  prevent duplicate execution.
* **Production-network gating.** Production execution is off unless it is enabled by environment
  variable *and* allow-listed per chain, *and* at least `threshold` owners are verified by signature.
* **Testnet tools** (`/testnet`): faucets, plus one-click deployment of sample assets that exercise
  each edge case (fee-on-transfer, restricted, soulbound, ERC-721, ERC-1155).
* **Receipt export (JSON)**, an "Open in Safe{Wallet}" link, and security follow-up recommendations.
* **Follow-up migrations.** "Start a new migration" rescans the wallet for assets that arrived later,
  keeping owners and threshold so they go to the same Safe. Reconnecting after a completed run opens
  a fresh portfolio scan, and replaced runs are archived locally (last 10).

### Experimental (implemented; validation depends on the wallet)
* **EIP-5792 atomic batching (EIP-7702 wallets).** On wallets that batch, such as MetaMask's smart
  account (EIP-7702 to the wallet's own delegate), each network takes **one batch** for the Safe
  deployment plus every token and NFT transfer, then one native transfer. Detection uses
  `wallet_getCapabilities`, execution uses `wallet_sendCalls` with `atomicRequired: true`, and
  results are tracked with `wallet_getCallsStatus`. If the wallet cannot batch, the app falls back
  to sequential transactions. Verified on a Sepolia fork with a real EIP-7702 transaction; not yet
  with a real wallet. See [docs/BATCHING.md](docs/BATCHING.md).
* **Production networks** (Ethereum, Base, Arbitrum, Optimism, Polygon). Discovery and planning work.
  Execution is gated; see [docs/SECURITY.md](docs/SECURITY.md) before enabling mainnet.

---

## Quick start

Requirements: Node.js 20+ and npm.

```bash
npm install
cp .env.example .env.local      # optional; the defaults work on testnets with public RPCs
npm run dev                     # http://localhost:3000
```

All credentials, such as RPC and indexer keys, are **server-only** environment variables. They are
used only by the read-only `/api/rpc/[chainId]` proxy and by `/api/discovery`, and they never reach the
browser bundle. The proxy forwards an allow-list of read methods and rejects signing and broadcasting
methods. See [.env.example](.env.example) for every option.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev server / production build / production server |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `npm test` | Vitest unit tests (offline) |
| `npm run test:network` | Read-only checks against live Sepolia, Chiado and Base Sepolia (version negotiation, address parity) |
| `npm run test:fork` | **End-to-end migration on local forks of Sepolia + Chiado** (see below) |
| `npm run test:fork:aave` | Aave v3 beta against the real Sepolia Aave deployment on a fork (required before enabling the beta) |
| `npm run test:local` | Fork suite + saved-Safe scenarios on **local Hardhat chains seeded with the canonical Safe v1.3.0 bytecode** (no public RPC needed) |
| `npm run test:e2e:local` | All Playwright tests, including two-browser owner verification and the full workspace flow, against those local chains |
| `npm run test:e2e` | Playwright UI smoke tests (run `npm run build` and `npx playwright install chromium` first) |
| `npm run compile:contracts` | Recompiles the testnet sample contracts into `src/lib/testnet/artifacts.json` |
| `node scripts/screenshots.mjs` | Regenerates `docs/screenshots/*` against a server on port 3100 |

## Testnet demonstration

The full walkthrough is in [docs/TESTNET_GUIDE.md](docs/TESTNET_GUIDE.md). In short:

1. Get Sepolia ETH and Chiado xDAI from the faucets listed on `/testnet`. About 0.05 of each is plenty.
2. On `/testnet`, deploy the sample assets on both networks (for example, Demo USD, the fee token and
   the restricted token). They are added to discovery automatically.
3. On `/`, connect, select assets, enter the owners and threshold, review the preview and click **Migrate to Safe**.
4. Approve each prompt. One-by-one, that means 1 deployment plus 1 transaction per asset on each
   network, plus a network switch. With atomic batching it is 1 batch plus 1 native transfer per network.
5. The completion screen re-reads the Safe and both balances onchain and links to Safe{Wallet}.

## How it was verified

| Layer | How | Real or mocked |
| --- | --- | --- |
| Math, validation, classification, planning, state machine, deployment-calldata inspection, EIP-712 challenges | `npm test` (179 tests in v1.5) | Pure logic. Signatures are real (viem accounts). |
| Executor control flow (rejection, retry, resume, dropped transactions, deploy-in-batch, batch revert, batching fallback, gating) | `npm test` | Wallet and chain **mocked** |
| EIP-5792 capability and status parsing | `npm test` | Wallet responses **mocked** |
| Canonical contracts, version negotiation, same address on Sepolia, Chiado and Base Sepolia | `npm run test:network` | **Live** testnet reads |
| Full migration: discovery → plan → Protocol Kit deployment → transfers → onchain verification, on both chains | `npm run test:fork` (6 scenarios) | **Real EVM execution on local forks** with the real Safe contracts and throwaway keys |
| UI flows (connect, discover, testnet page, RPC proxy rejects broadcasts) | `npm run test:e2e` | Real server and real RPC reads; read-only injected wallet |
| v1.5 profiles, invites, receipts (hash vectors), late arrivals, readiness, Aave decisions | `npm test` | Pure logic, real signatures; chain reads mocked where stated |
| Add network, sweeps, divergence blocking, outgoing-tx evidence, the original fork scenarios | `npm run test:local` | **Real EVM + real Safe bytecode on local chains**, not live-network state |
| Two-device owner verification; migrate → receipts → saved Safe → sweep → add network in the real UI | `npm run test:e2e:local` | Real UI and local chains; mock wallets backed by throwaway keys |

The fork suite covers the following scenarios:
* The same Safe address is deployed on both chains, with owners and threshold verified.
* mUSD and native balances arrive in full.
* The fee-on-transfer token is flagged `verified_with_discrepancy`.
* The restricted token is excluded by simulation and stays in the source.
* An existing matching Safe is reused and no deployment is sent.
* A rejected transfer stops the run; Retry resumes without redeploying.
* A session killed right after a transfer's hash was saved resumes **without resending** it.
* One EIP-7702 batch deploys a **3-of-5** Safe and moves an ERC-20, three ERC-721s and an ERC-1155
  collection; the native remainder follows as one transaction.

Reported by the project owner (no hashes attached, so not independently verified here): successful
public-testnet migrations across Sepolia + Chiado and Sepolia + Base Sepolia + Chiado. Not yet done:
an atomic batch through a real wallet's EIP-5792 implementation, and any v1.5 workspace feature on
public testnets with a real wallet (see the v1.5 checklist in [docs/POC_VALIDATION.md](docs/POC_VALIDATION.md)).

---

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): service map, state model and design decisions
* [docs/SAFE_DEPLOYMENT.md](docs/SAFE_DEPLOYMENT.md): how deterministic Safe deployment works here
* [docs/BATCHING.md](docs/BATCHING.md): which kinds of batching are and are not supported, and why
* [docs/SECURITY.md](docs/SECURITY.md): security model, assumptions, limitations and the mainnet checklist
* [docs/TESTNET_GUIDE.md](docs/TESTNET_GUIDE.md): faucets, sample assets and demo scenarios
* [docs/MILESTONES.md](docs/MILESTONES.md): milestone status
* [docs/POC_REVIEW.md](docs/POC_REVIEW.md): PoC hardening findings and fix status
* [docs/POC_VALIDATION.md](docs/POC_VALIDATION.md): manual real-wallet validation checklist and evidence template
* [docs/V1_5_IMPLEMENTATION.md](docs/V1_5_IMPLEMENTATION.md): v1.5 design decisions, evidence and remaining work

## Repository layout

```
src/app/                 Pages (/, /testnet, /invite, /receipt) and API routes (/api/rpc/[chainId], /api/discovery)
src/components/          Screens, state provider, hooks, UI primitives
src/lib/chains/          Network registry, execution gating, RPC policy, clients
src/lib/domain/          Types and BigInt amount math
src/lib/services/        Discovery, signers, deployment, gas, capabilities, planning, transfer, execution, verification,
                         saved profiles, owner invites, receipts (+PDF), chain extension, late arrivals, readiness,
                         protocol adapters (protocols/)
src/lib/state/           Migration state machine and local persistence
contracts/               Testnet-only sample assets (never for mainnet)
scripts/local-chain*     Local Hardhat chains seeded with the canonical Safe v1.3.0 bytecode (test harness)
tests/unit|integration|e2e|fixtures
```

## License

MIT. The testnet sample contracts in `contracts/` are unaudited demo code.
