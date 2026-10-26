# Batching: what is supported and what is not

Code: `src/lib/services/transaction-capability.ts` (detection and status parsing) and the
`runDeploymentInBatch` / `runAtomic` / `runSequential` functions in `src/lib/services/migration-execution.ts`.

## Summary

| Strategy | When | Status |
| --- | --- | --- |
| **1. Wallet atomic batching (EIP-5792)**: Safe deployment + every token transfer in one transaction, then native | The wallet reports `atomic.status` = `supported` or `ready` for the chain | 🧪 Implemented. Verified on a Sepolia fork with an EIP-7702 test wallet; **not yet run with a real wallet** |
| **2. Sequential EOA transactions** | Everything else, and as the automatic fallback | ✅ Implemented; verified end to end on Sepolia/Chiado forks and on public Sepolia |
| **3. ERC-4337 sponsorship, relayers, an app-chosen EIP-7702 delegate** | — | ⏳ Not planned (see "EIP-7702" below) |

Wallet prompts per network, for a Safe that is not deployed yet:

| Strategy | Prompts |
| --- | --- |
| Sequential | 1 deployment + 1 per asset + 1 native |
| Atomic batch | **1 batch** (deployment + all tokens and NFTs) + 1 native, plus a one-time account upgrade if the wallet needs it |

Networks are separate chains, so each one always needs its own prompts.

## EIP-7702: how it is used, and why the app does not pick a delegate

EIP-7702 lets an EOA point its code at a delegate contract, so one transaction from the EOA can run
many calls. Wallets such as MetaMask use this to implement EIP-5792: when you approve a batch, the
wallet upgrades your account to **its own audited delegate** (MetaMask calls this a "smart
account"), then runs the calls. Safe Migrator benefits from this by calling `wallet_sendCalls`;
the wallet does the delegation.

The app deliberately does **not** ask you to delegate to a contract it chooses:

* **Browser wallets do not let dapps request EIP-7702 authorizations.** An authorization hands
  the delegate full control over every asset in the account, on every chain if `chainId` is 0, so
  wallets keep that decision to themselves.
* **A delegate is a single point of failure.** A bug or a malicious upgrade in it can drain the
  account. The project rules forbid shipping an unaudited delegate.
* **It adds nothing here.** The wallet's own delegate already gives atomic batching.

The fork test uses a ~10-line test-only delegate (`TestBatchExecutor`, compiled inside the test) to
stand in for the wallet's contract. It is never deployed or used by the app.

After the first batch, the source EOA is EIP-7702-delegated to the wallet's contract. It is still
controlled by its one key. Revoke the delegation in the wallet if you no longer want it.

## Strategy 1: EIP-5792

[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792) lets a dapp ask the *wallet* to execute several
calls from the user's account.

1. **Detection.** The preview calls `wallet_getCapabilities(account, [chainIds])`. The parser:
   * reads `atomic.status` per chain, then falls back to the `0x0` (all chains) entry;
   * treats a missing method, an error or an unknown value as **unsupported**;
   * does **not** treat the pre-final `atomicBatch: { supported: true }` shape as atomic support,
     because it does not carry the final spec's `atomicRequired` guarantee. The UI shows a note instead.
2. **What gets batched**, for **one chain** at a time:
   * **The Safe deployment, as the first call**, when the Safe does not exist yet. Before sending,
     the executor rebuilds the deployment with Protocol Kit, decodes and checks it (factory,
     singleton, owners/threshold-only `setup`, salt), and recomputes the CREATE2 address **from that
     calldata**. The batch is only sent if this address equals the verified Safe address that the
     transfers target.
   * **Every ERC-20 `transfer` and ERC-721/1155 `safeTransferFrom`.**
   * **Not the native remainder.** The wallet chooses the batch's gas limit and fee. A native
     transfer sized as "balance minus our reserve" can exceed what is left and revert the whole
     batch; the fork test hit exactly this during gas estimation. The native transfer is sent
     afterwards as its own transaction, sized from the balance after the batch, and **only once the
     Safe is deployed and verified**.
3. **Submission.** `wallet_sendCalls` with `{ version: "2.0.0", chainId, from, atomicRequired: true, calls }`.
   With `atomicRequired: true` the wallet must either execute all calls atomically or refuse.
4. **Why deployment and transfers may share a batch.** The original rule was "never send assets to
   an unverified Safe". In an atomic batch the transfers can only land if the deployment in the
   same transaction succeeds. The CREATE2 address commits to the factory, singleton, initializer
   (owners and threshold) and salt, so a successful deployment at that address *is* the verified
   configuration. If anything already exists at the address, the factory reverts and so does every
   transfer. Right after the batch, the Safe is inspected onchain exactly like a standalone
   deployment, and any mismatch is flagged.
5. **Tracking.** The returned call-bundle ID is **persisted before polling**. Then `wallet_getCallsStatus` is polled:

   | Code | Meaning | What the executor does |
   | --- | --- | --- |
   | 100 | Pending | Keep polling. On timeout, the chain goes to *Needs attention* and Resume reconciles. |
   | 200 | Confirmed | Wait for the confirmation depth, verify the Safe (if deployed in the batch), then verify **every** transfer by balance or ownership reads. If `atomic: false` comes back, a warning is logged and each item is still verified individually. |
   | 400 | Failed offchain | Every action in the batch is marked failed; nothing moved; Retry is allowed. |
   | 500 | Reverted | Each action is verified; anything not delivered is marked failed. The native transfer is not sent. |
   | 600 | Partially reverted | Each action is verified individually and the result is recorded per asset. |

6. **Errors at submission.**
   * `4001`: the user rejected. The run stops and nothing is assumed.
   * `5750`: the user declined the wallet's account upgrade. The chain is marked *Needs attention*,
     with a suggestion to switch it to one-by-one transactions.
   * Any other error, such as an unsupported method or the wallet failing to batch: the run
     **falls back to sequential** for that chain (deploy, verify, then transfer), with no lost state.
7. **Strategy toggle.** In the preview, each network can be switched between one-by-one and atomic
   (when supported). The expected number of confirmations updates to match.

## Strategy 2: sequential fallback

The connected wallet signs ordinary transactions one at a time. The order is: deploy (if needed),
then tokens and NFTs, then native last (recomputed just before sending, after reserving gas for
anything remaining). Each transaction is:
1. simulated;
2. gas-checked;
3. sent, with its hash persisted;
4. confirmed;
5. verified before the next one starts.

## What is deliberately *not* claimed

* **No cross-chain atomicity.** Batches never span networks. A failure on Chiado does not undo
  Sepolia; the progress screen shows each network independently.
* **Safe MultiSend is not EOA batching.** MultiSend batches calls *made by a Safe*. An EOA calling
  MultiSend would need `delegatecall`, which an EOA cannot do. A plain call would make MultiSend
  itself the `msg.sender`, so it could not move the EOA's tokens without approvals. The app does
  neither.
* **EIP-7702 delegation is not a Safe.** An EIP-7702-delegated EOA is still controlled by its single
  original key. Delegating the source EOA does not create a multisig; only the deployed Safe does.
  The connect screen detects delegated EOAs (`0xef0100…` code) and labels them accordingly.
* **Confirmation counts are estimates of prompts.** The preview's count covers network switches, the
  deployment, the transfer transactions or batch, and the native transfer. A wallet may show extra
  screens, for example an account-upgrade prompt. The UI says so.

## Tests

`tests/unit/capabilities.test.ts` covers:
* per-chain and `0x0` capabilities, the pre-final `atomicBatch` shape and error responses;
* `wallet_sendCalls` parameter building;
* every status code range.

`tests/unit/execution.test.ts` drives the executor with mocked EIP-5792 responses:
* deployment and tokens in one batch, then native;
* a Safe that already exists, so the batch carries transfers only;
* a deployment whose CREATE2 address differs from the target, so nothing is sent;
* a reverted batch, which sends no native transfer, followed by a safe retry;
* a rejected batch;
* fallback on an unsupported method.

`tests/integration/fork-migration.test.ts` (`npm run test:fork`) runs the real executor on a Sepolia
fork with a wallet that implements EIP-5792 through a real EIP-7702 type-4 transaction. One
transaction deploys a **3-of-5** Safe and moves an ERC-20, three ERC-721s and an ERC-1155 collection
into it. The native remainder follows as one more transaction. The test then checks the Safe's owners
and threshold and every balance onchain.

**Not yet done:** the same flow with a real wallet (for example MetaMask's smart account) on public
Sepolia. Each wallet's batching implementation differs, so this is the next validation step.
