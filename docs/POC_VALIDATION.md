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
