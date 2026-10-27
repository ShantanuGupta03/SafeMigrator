# PoC validation playbook (Sepolia + Gnosis Chiado)

Use this checklist to produce **reproducible evidence** for the public PoC. Cursor cannot sign transactions in your browser; a human must run the wallet steps and attach screenshots, tx hashes and the exported JSON receipt.

## Evidence to collect

| Item | Where |
| --- | --- |
| Safe address (same on Sepolia + Chiado when both selected) | Signers + Complete screens |
| Deployment tx per network | Progress / Complete / block explorer |
| Transfer txs or batch ID | Progress / Complete |
| Exported receipt | Complete → Export receipt (JSON) |
| Residual source balances | Complete → “Still in …” |
| Outgoing Safe tx with 2 owners | Safe{Wallet} (separate from this app) |

## 1. Fund a disposable EOA

1. Create or use a **throwaway** EOA (not your main wallet).
2. Fund **Sepolia** (~0.05 ETH) and **Gnosis Chiado** (~0.05 xDAI) via faucets in [TESTNET_GUIDE.md](TESTNET_GUIDE.md).
3. Record the address and faucet tx hashes.

## 2. Deploy sample assets

1. Open `/testnet`, connect the EOA, switch to **Sepolia**.
2. Deploy at least: **Demo USD (mUSD)**, one **ERC-721** preset, one **ERC-1155** preset (redeploy ERC-1155 if you used an older build).
3. Repeat on **Chiado** for mUSD + native xDAI already present.
4. Note each deployment tx hash.

## 3. Connect and discover

1. Open `/`, connect the same EOA.
2. Confirm **Portfolio** lists assets on both networks; note any “partial” coverage warnings.
3. Select assets to migrate; **deselect a network** once and confirm no assets on that network appear on Signers/Review (regression for selection).

## 4. Configure 2-of-3 Safe

1. **Signers:** three distinct addresses (connected wallet + two others).
2. Keep **2 of 3** threshold.
3. **Verify control** of at least **two** owners (switch accounts in the wallet per card).
4. Confirm **same Safe address** on Sepolia and Chiado in the target list.

## 5. Review and sequential migration

1. On **Review**, wait for preflight to finish; click **Re-check** if the banner says preflight is stale.
2. If any network is blocked, read the partial-migration alert and acknowledge explicitly before starting.
3. Run **sequential** mode first (one-by-one transactions) on **both** networks.
4. Approve deploy, each transfer, and native remainder per network.

## 6. Onchain verification

For each network:

- [ ] Safe code at predicted address; owners and threshold match.
- [ ] Selected ERC-20 / NFT balances in the Safe (block explorer or Complete screen).
- [ ] Residual balances in the source match expectations (gas dust, skipped assets).
- [ ] Receipt JSON includes `scope` and `migrationOutcome`.

## 7. Safe{Wallet} outgoing transaction

1. Open the Safe in [Safe{Wallet}](https://app.safe.global) on Sepolia.
2. Propose a **0-value** test transaction (or send a small amount to yourself).
3. Collect **two independent owner signatures** and execute.
4. Save the Safe tx hash as proof the multisig works.

## 8. Atomic batching (optional, real wallet)

Only after sequential success:

1. Fund the EOA again with small amounts on **one** network.
2. On Review, choose **atomic batch** if the wallet reports EIP-5792 support.
3. Accept or reject MetaMask’s smart-account upgrade deliberately and record behavior.
4. Test: rejection, timeout (airplane mode briefly), disconnect mid-prompt, then **Resume**.

**Do not mark batching “passed”** without a successful public testnet batch tx hash.

## Required negative scenarios

| Scenario | Expected behavior |
| --- | --- |
| Deselect Chiado after discovery | No Chiado actions in Review or wallet |
| One network lacks gas | Blocked on Review; partial ack required |
| Switch source account mid-run | Transactions blocked; banner shown |
| Reject deployment | `rejected`; Retry without redeploying verified steps |
| Reject a transfer | Same |
| Close tab during `awaiting_wallet` | Resume → `uncertain`; reconcile before retry |
| Lost RPC response after send | `uncertain` or pending reconcile; no blind retry |
| Transfer reverts | `failed` / `reverted`; safe retry rules |
| Indexer failure | Partial discovery; manual import still works |
| Wrong Safe already deployed | `deployed_mismatch`; blocked |
| Expired owner proof | Execution blocked until re-verify |
| Tampered localStorage migration | Proofs re-validated at run; invalid sig fails |
| Retry after verified transfer | Action not re-sent |

## Commands (automated evidence)

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
RUN_NETWORK_TESTS=1 npm run test:network
npm run test:fork
```

Record versions, date and machine in your evidence folder. If RPC keys are missing, say so explicitly — do not claim live reads passed.

---

# v1.5 public-testnet validation (workspace features)

Reported history: the project owner reports successful public-testnet migrations on
**Sepolia + Chiado** and **Sepolia + Base Sepolia + Chiado** (v1). No hashes or receipts were attached,
so these stay *user-reported* until the evidence template below is filled in for them.

Automated evidence so far comes from mocks, unit tests and **local Hardhat chains seeded with the
canonical Safe bytecode** (`npm run test:local`, `npm run test:e2e:local`). None of it replaces the
public-testnet runs below. Use two browsers or devices and at least two wallets you control.

## Checklist

1. [ ] **Pinning.** Connect a fresh source EOA, select Sepolia + Chiado (+ Base Sepolia), enter 3 owners,
       2-of-3. Freeze the configuration. Note the commitment and address shown on Signers and Saved Safes.
2. [ ] **Remote verification.** Invite owner 2 and open the link on a *second device/browser profile*.
       Confirm the co-owner page recomputes the address ("Recomputed on …") and shows the full owner
       list. Sign on Chiado. Paste the response on device 1 → "Verified (signed on Gnosis Chiado)".
       Paste it again → "already imported", still 1 verification. Edit the threshold → the invitation shows
       "Invalid (configuration changed)"; restore it and invite again.
3. [ ] **Negative invites.** Import a response after editing one character of its JSON (rejected);
       sign with the wrong account (rejected); revoke an invitation, then import its response (rejected).
4. [ ] **Migration.** Run sequentially on two networks. Export the receipt JSON and PDF. Inspect the
       JSON at `/receipt` ("Integrity hash matches"), then edit one amount and inspect again ("does NOT match").
       Click "Recheck onchain".
5. [ ] **Reload.** Close the tab, reopen, reconnect: the saved Safe is there with the same commitment.
       Export the profile, clear site data, import it: same commitment and address.
6. [ ] **Add network.** From Saved Safes add the remaining network; confirm the same address and that the
       Safe is verified before it shows as deployed.
7. [ ] **Late arrival + sweep.** Send a token or some native coin to the source. "Check for new assets"
       lists it; "Review sweep" goes through Review with *no* deployment for networks where the Safe
       exists. Ignore an item and check again: it stays ignored.
8. [ ] **Readiness.** In Safe{Wallet}, execute a small 2-of-3 transaction from the Safe; paste its hash in
       the readiness panel → "Observed onchain". Paste a plain deposit hash → rejected.
9. [ ] **Divergence (optional, testnet).** In Safe{Wallet} change the threshold on one network. Re-read
       governance: "Governance changed". Add network is blocked; a sweep to that network requires
       accepting the reviewed governance.
10. [ ] **Batching (optional).** Repeat step 4 with a wallet that reports EIP-5792 atomic batching.

Do not mark a step passed without its evidence row.

## Evidence template

Copy one row per run or check into your evidence folder (or the PR description).

| Date (UTC) | Build commit | Wallet + version | Device/browser | Networks | Strategy | Step | Tx hashes / batch IDs | Receipt hash | Expected | Observed | Pass? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | `NEXT_PUBLIC_BUILD_COMMIT` from the receipt | e.g. MetaMask 12.x | | Sepolia, Chiado | sequential | 4 | | `0x…` | | | |

Attach: the receipt JSON and PDF, screenshots of Saved Safes and readiness, and the co-owner page.
