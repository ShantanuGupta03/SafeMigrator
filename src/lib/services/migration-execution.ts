import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";
import { executionGate, getChain } from "@/lib/chains/registry";
import type { ActionError, ChainMigration, ChainPhase, Migration, MigrationAction, SafeInspection } from "@/lib/domain/types";
import { chainOutcome, SUCCESS_STATUSES, type MigrationEvent } from "@/lib/state/machine";
import {
  amountsMateriallyChanged,
  buildTransferCall,
  pruneZeroErc1155,
  readSafeBalances,
  refreshTransferAmounts,
  simulateTransfer,
  verifyTransfer,
} from "./asset-transfer";
import { validateMigrationOwnerProofs } from "./owner-readiness";
import { adapterFor, interpretWithAdapter } from "./protocols";
import { classifySubmissionError } from "./submission-errors";
import { estimateCallGas, estimateL1DataFee, getFeeQuote, isDust, maxCost, spendableNative, type FeeQuote } from "./gas-estimation";
import { compareSafeToConfig, compareSafeToGovernance, inspectSafe } from "./onchain-verification";
import { buildDeploymentTransaction, deploymentTargetAddress } from "./safe-deployment";
import {
  sendAtomicBatch,
  waitForCallsStatus,
  interpretCallsStatus,
  type BatchCall,
  type BatchOutcome,
  type Eip1193Requester,
} from "./transaction-capability";
import { assertSourceAccount, errorMessage, isUserRejection, WrongAccountError, WrongChainError } from "./wallet-connection";

/* --------------------------------- Ports ---------------------------------- */

export interface SendTxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/** Abstraction over the connected wallet (wagmi in the app, mocks in tests). */
export interface WalletPort {
  getAccount(): Address | undefined;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
  sendTransaction(req: SendTxRequest): Promise<Hex>;
  provider(chainId: number): Promise<Eip1193Requester>;
}

export interface ExecutorDeps {
  wallet: WalletPort;
  clientFor(chainId: number): PublicClient;
  dispatch(e: MigrationEvent): void;
  getMigration(): Migration;
  shouldStop(): boolean;
  receiptTimeoutMs?: number;
  batchTimeoutMs?: number;
}

/** Stops the whole run (user rejection, wrong account, pause). Other chains keep their state. */
export class HaltRun extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaltRun";
  }
}

class ReceiptTimeout extends Error {}

/* -------------------------------- Helpers --------------------------------- */

/** Transfer verification, interpreted by the action's protocol adapter when it has one. */
async function verifyAction(...args: Parameters<typeof verifyTransfer>) {
  return interpretWithAdapter(args[1], await verifyTransfer(...args));
}

/**
 * Checks an already deployed Safe before assets go into it: the original configuration, or the
 * exact governance the user reviewed when the Safe's owners or settings changed after deployment.
 * A Safe deployed by this run is always checked against the original configuration instead.
 */
function destinationIssues(insp: SafeInspection, m: Migration, c: ChainMigration): string[] {
  return c.expectedGovernance ? compareSafeToGovernance(insp, c.expectedGovernance) : compareSafeToConfig(insp, m.safeConfig, c.contracts);
}

function chainOf(deps: ExecutorDeps, chainId: number): ChainMigration {
  const c = deps.getMigration().chains.find((x) => x.chainId === chainId);
  if (!c) throw new Error(`Chain ${chainId} not in migration`);
  return c;
}

function actionOf(deps: ExecutorDeps, chainId: number, id: string): MigrationAction {
  const a = chainOf(deps, chainId).actions.find((x) => x.id === id);
  if (!a) throw new Error(`Action ${id} not found`);
  return a;
}

function phase(deps: ExecutorDeps, chainId: number, p: ChainPhase, message: string | null = null) {
  deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { phase: p, message } });
}

function patch(deps: ExecutorDeps, chainId: number, actionId: string, p: Partial<MigrationAction>) {
  deps.dispatch({ type: "ACTION_PATCH", chainId, actionId, patch: p });
}

function log(deps: ExecutorDeps, chainId: number | null, level: "info" | "warn" | "error", message: string, extra: { actionId?: string; txHash?: Hex } = {}) {
  deps.dispatch({ type: "LOG", entry: { chainId, actionId: extra.actionId ?? null, level, message, txHash: extra.txHash } });
}

function fail(code: ActionError["code"], message: string): ActionError {
  return { code, message };
}

function feePaid(receipt: TransactionReceipt): string {
  const l1 = (receipt as unknown as { l1Fee?: bigint | null }).l1Fee ?? 0n;
  return (receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n) + (l1 ?? 0n)).toString();
}

function feeFields(fee: FeeQuote) {
  return fee.eip1559
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: fee.maxFeePerGas };
}

async function ensureWallet(deps: ExecutorDeps, chainId: number) {
  const m = deps.getMigration();
  phase(deps, chainId, "waiting_wallet", "Confirm the network switch in your wallet if prompted.");
  try {
    assertSourceAccount(m.source, deps.wallet.getAccount());
  } catch (e) {
    phase(deps, chainId, "needs_attention", (e as Error).message);
    throw new HaltRun((e as Error).message);
  }
  let current = await deps.wallet.getChainId();
  if (current !== chainId) {
    try {
      await deps.wallet.switchChain(chainId);
    } catch (e) {
      const msg = isUserRejection(e)
        ? `Network switch to ${getChain(chainId).name} was rejected. Nothing was sent.`
        : `Could not switch to ${getChain(chainId).name}: ${errorMessage(e)}`;
      phase(deps, chainId, "needs_attention", msg);
      throw new HaltRun(msg);
    }
    current = await deps.wallet.getChainId();
  }
  if (current !== chainId) {
    const err = new WrongChainError(chainId, current);
    phase(deps, chainId, "needs_attention", err.message);
    throw new HaltRun(err.message);
  }
}

async function waitReceipt(deps: ExecutorDeps, chainId: number, actionId: string, hash: Hex): Promise<{ receipt: TransactionReceipt; cancelled: boolean }> {
  const client = deps.clientFor(chainId);
  let cancelled = false;
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: getChain(chainId).confirmations,
      timeout: deps.receiptTimeoutMs ?? 10 * 60_000,
      onReplaced: (r) => {
        cancelled = r.reason === "cancelled";
        patch(deps, chainId, actionId, { txHash: r.transaction.hash });
        log(deps, chainId, "warn", `Transaction ${r.reason} in wallet; now tracking ${r.transaction.hash}.`, { actionId, txHash: r.transaction.hash });
      },
    });
    return { receipt, cancelled };
  } catch (e) {
    if ((e as Error).name === "WaitForTransactionReceiptTimeoutError") throw new ReceiptTimeout(`Still waiting for ${hash}`);
    throw e;
  }
}

async function markUncertain(deps: ExecutorDeps, chainId: number, actionIds: string[], reason: string) {
  const client = deps.clientFor(chainId);
  const source = deps.getMigration().source;
  const latest = await client.getTransactionCount({ address: source, blockTag: "latest" });
  const pending = await client.getTransactionCount({ address: source, blockTag: "pending" });
  for (const id of actionIds) {
    const a = actionOf(deps, chainId, id);
    patch(deps, chainId, id, {
      status: "uncertain",
      error: fail("submission_unknown", reason),
      uncertainty: {
        reason,
        nonce: a.txNonce,
        latestNonce: latest,
        pendingNonce: pending,
        checkedAt: Date.now(),
        userMayConfirmNotSent: pending <= latest,
        candidateTxHash: a.txHash,
      },
    });
  }
}

/** Throws HaltRun after recording a rejection or ambiguous submission; returns normally for definitive pre-broadcast errors. */
async function handleSendError(deps: ExecutorDeps, chainId: number, actionIds: string[], e: unknown, what: string): Promise<never | void> {
  if (isUserRejection(e)) {
    for (const id of actionIds) patch(deps, chainId, id, { status: "rejected", error: fail("user_rejected", `${what} was rejected in your wallet. Nothing was sent.`) });
    phase(deps, chainId, "needs_attention", `${what} was rejected in your wallet. Nothing was sent. Use Retry when ready.`);
    throw new HaltRun("User rejected");
  }
  if (e instanceof WrongAccountError || e instanceof WrongChainError) {
    for (const id of actionIds) patch(deps, chainId, id, { status: "planned" });
    phase(deps, chainId, "needs_attention", e.message);
    throw new HaltRun(e.message);
  }
  const cls = classifySubmissionError(e);
  const msg = errorMessage(e);
  if (cls === "ambiguous") {
    await markUncertain(deps, chainId, actionIds, `${what}: submission outcome unknown (${msg}). Resume to reconcile before retrying.`);
    phase(deps, chainId, "needs_attention", `${what} may have been submitted. Resume to reconcile — do not retry until the outcome is known.`);
    throw new HaltRun("ambiguous submission");
  }
  for (const id of actionIds) patch(deps, chainId, id, { status: "failed", error: fail("not_submitted", msg) });
}

async function reconcileAwaitingWallet(deps: ExecutorDeps, chainId: number, a: MigrationAction) {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const block = await client.getBlockNumber({ cacheTime: 0 });
  if (a.kind === "deploy_safe") {
    const insp = await inspectSafe(client, c.safeAddress, block);
    if (insp.hasCode) {
      const issues = compareSafeToConfig(insp, m.safeConfig, c.contracts);
      patch(deps, chainId, a.id, issues.length ? { status: "needs_attention", error: fail("verification_failed", issues.join(" ")) } : { status: "verified" });
      deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
      return;
    }
  } else {
    const outcome = await verifyAction(client, a, m.source, c.safeAddress, block);
    if (outcome.status === "verified" || outcome.status === "verified_with_discrepancy") {
      patch(deps, chainId, a.id, { status: outcome.status, verification: outcome.verification, error: null });
      return;
    }
  }
  await markUncertain(deps, chainId, [a.id], `${a.label}: wallet was open when the session ended; onchain outcome unknown.`);
  log(deps, chainId, "warn", `${a.label}: previous wallet prompt needs reconciliation.`, { actionId: a.id });
}

/* ------------------------------ Reconciliation ----------------------------- */

/**
 * Brings in-flight actions in line with chain state before anything new is sent. Hashes and batch
 * IDs were persisted before waiting, so an interrupted session resumes by looking them up.
 */
export async function reconcileChain(deps: ExecutorDeps, chainId: number): Promise<void> {
  const client = deps.clientFor(chainId);
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);

  for (const a of [...c.actions]) {
    if (a.status === "awaiting_wallet") await reconcileAwaitingWallet(deps, chainId, a);
  }

  // Batches
  for (const b of c.batches.filter((x) => x.statusCode === null || (x.statusCode >= 100 && x.statusCode < 200))) {
    const actions = b.actionIds.map((id) => actionOf(deps, chainId, id)).filter((a) => a.status === "submitted");
    if (!actions.length) continue;
    let outcome: BatchOutcome = { state: "unknown", code: null };
    try {
      const provider = await deps.wallet.provider(chainId);
      outcome = interpretCallsStatus(await provider.request({ method: "wallet_getCallsStatus", params: [b.callsId] }));
    } catch {
      outcome = { state: "unknown", code: null };
    }
    await applyBatchOutcome(deps, chainId, b.callsId, actions.map((a) => a.id), outcome, true);
  }

  // Individual transactions
  for (const a of chainOf(deps, chainId).actions) {
    if (!(a.status === "submitted" || a.status === "verifying") || !a.txHash) continue;
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await client.getTransactionReceipt({ hash: a.txHash });
    } catch {
      receipt = null;
    }
    if (!receipt) {
      const pendingTx = await client.getTransaction({ hash: a.txHash }).catch(() => null);
      if (pendingTx) {
        try {
          const r = await waitReceipt(deps, chainId, a.id, a.txHash);
          receipt = r.receipt;
        } catch (e) {
          if (e instanceof ReceiptTimeout) {
            phase(deps, chainId, "needs_attention", `${a.label} is still pending onchain. Resume later.`);
            throw new HaltRun("pending");
          }
          throw e;
        }
      } else {
        const latest = await client.getTransactionCount({ address: m.source, blockTag: "latest" });
        if (a.txNonce !== null && latest > a.txNonce) {
          patch(deps, chainId, a.id, {
            status: "failed",
            error: fail("not_landed", "This transaction's nonce was used by another transaction and will not land."),
          });
          continue;
        }
        await reconcileByEndState(deps, chainId, a.id, m.source, c.safeAddress, "Transaction is no longer known to the network (dropped or replaced).");
        continue;
      }
    }
    await settleReceipt(deps, chainId, a.id, receipt, false);
  }
}

/** When a tx hash cannot be resolved, decide from balances/ownership alone. */
async function reconcileByEndState(deps: ExecutorDeps, chainId: number, actionId: string, source: Address, safe: Address, reason: string) {
  const client = deps.clientFor(chainId);
  const a = actionOf(deps, chainId, actionId);
  if (a.kind === "deploy_safe") {
    const insp = await inspectSafe(client, safe);
    if (insp.hasCode) {
      patch(deps, chainId, a.id, { status: "verifying" });
      const issues = compareSafeToConfig(insp, deps.getMigration().safeConfig, chainOf(deps, chainId).contracts);
      patch(deps, chainId, a.id, issues.length ? { status: "needs_attention", error: fail("verification_failed", issues.join(" ")) } : { status: "verified" });
      deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
      return;
    }
    patch(deps, chainId, a.id, { status: "needs_attention", error: fail("dropped", `${reason} The Safe is not deployed.`) });
    return;
  }
  const block = await client.getBlockNumber({ cacheTime: 0 });
  patch(deps, chainId, a.id, { status: "verifying" });
  const outcome = await verifyAction(client, a, source, safe, block);
  if (outcome.status === "needs_attention") {
    patch(deps, chainId, a.id, { status: "needs_attention", verification: outcome.verification, error: fail("dropped", `${reason} No transfer was detected.`) });
  } else {
    patch(deps, chainId, a.id, { status: outcome.status, verification: { ...outcome.verification, note: `${outcome.verification.note ?? ""} Reconciled from onchain state.`.trim() } });
  }
}

async function settleReceipt(deps: ExecutorDeps, chainId: number, actionId: string, receipt: TransactionReceipt, cancelled: boolean) {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const a = actionOf(deps, chainId, actionId);
  if (receipt.status !== "success" || cancelled) {
    patch(deps, chainId, a.id, {
      status: "failed",
      feePaid: feePaid(receipt),
      error: fail("reverted", cancelled ? "Transaction was cancelled in the wallet." : "Transaction reverted onchain. Nothing moved."),
    });
    log(deps, chainId, "error", `${a.label} reverted.`, { actionId: a.id, txHash: receipt.transactionHash });
    return;
  }
  patch(deps, chainId, a.id, { status: "verifying", feePaid: feePaid(receipt), txHash: receipt.transactionHash });
  if (a.kind === "deploy_safe") {
    phase(deps, chainId, "verifying_safe");
    const insp = await inspectSafe(client, c.safeAddress, receipt.blockNumber);
    const issues = compareSafeToConfig(insp, m.safeConfig, c.contracts);
    deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
    if (issues.length) {
      patch(deps, chainId, a.id, { status: "needs_attention", error: fail("verification_failed", issues.join(" ")) });
    } else {
      patch(deps, chainId, a.id, { status: "verified" });
      log(deps, chainId, "info", `Safe deployed and verified at ${c.safeAddress}.`, { actionId: a.id, txHash: receipt.transactionHash });
    }
    return;
  }
  phase(deps, chainId, "verifying_balances");
  const outcome = await verifyAction(client, actionOf(deps, chainId, a.id), m.source, c.safeAddress, receipt.blockNumber, receipt);
  patch(deps, chainId, a.id, {
    status: outcome.status,
    verification: outcome.verification,
    error: outcome.status === "needs_attention" ? fail("verification_failed", outcome.verification.note ?? "Verification failed") : null,
  });
  log(deps, chainId, outcome.status === "verified" ? "info" : "warn", `${a.label}: ${outcome.status.replace(/_/g, " ")}.`, {
    actionId: a.id,
    txHash: receipt.transactionHash,
  });
}

async function applyBatchOutcome(deps: ExecutorDeps, chainId: number, callsId: string, actionIds: string[], outcome: BatchOutcome, reconciling: boolean) {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const code = "code" in outcome ? outcome.code : outcome.state === "confirmed" ? 200 : null;
  deps.dispatch({
    type: "BATCH_PATCH",
    chainId,
    callsId,
    patch: {
      statusCode: code,
      atomic: outcome.state === "confirmed" ? outcome.atomic : null,
      transactionHashes: "receipts" in outcome ? outcome.receipts.map((r) => r.transactionHash) : [],
    },
  });

  switch (outcome.state) {
    case "pending":
      phase(deps, chainId, "needs_attention", "The batch is still pending in your wallet. Resume later to reconcile.");
      throw new HaltRun("batch pending");
    case "failed_offchain":
      for (const id of actionIds) {
        patch(deps, chainId, id, { status: "failed", error: fail("batch_failed", `Wallet reported the batch was not submitted (status ${outcome.code}). Nothing moved.`) });
      }
      return;
    case "unknown":
      if (!reconciling) {
        phase(deps, chainId, "needs_attention", "Batch status unknown. Resume to reconcile from onchain balances.");
        throw new HaltRun("batch unknown");
      }
      for (const id of actionIds) await reconcileByEndState(deps, chainId, id, m.source, c.safeAddress, "Batch status unavailable from wallet.");
      return;
    case "confirmed":
    case "partial":
    case "reverted": {
      const receipts = outcome.receipts;
      if (outcome.state === "confirmed" && !outcome.atomic) {
        log(deps, chainId, "warn", "Wallet executed the batch non-atomically despite atomicRequired; verifying each transfer.");
      }
      // Wait for confirmation depth on the last receipt before reading balances.
      const last = receipts[receipts.length - 1];
      let block = await client.getBlockNumber({ cacheTime: 0 });
      if (last) {
        const r = await client.waitForTransactionReceipt({ hash: last.transactionHash, confirmations: getChain(chainId).confirmations, timeout: deps.receiptTimeoutMs ?? 10 * 60_000 });
        block = r.blockNumber;
      }
      phase(deps, chainId, "verifying_balances");
      for (const [i, id] of actionIds.entries()) {
        const a = actionOf(deps, chainId, id);
        const txHash = receipts.length === actionIds.length ? receipts[i]!.transactionHash : (last?.transactionHash ?? null);
        patch(deps, chainId, id, { status: "verifying", txHash });
        if (a.kind === "deploy_safe") {
          await settleBatchedDeployment(deps, chainId, id, block, outcome.state === "reverted");
          continue;
        }
        const v = await verifyAction(client, a, m.source, c.safeAddress, block);
        if (v.status === "needs_attention" && outcome.state === "reverted") {
          patch(deps, chainId, id, { status: "failed", verification: v.verification, error: fail("reverted", "Batch reverted onchain. Nothing moved.") });
        } else {
          patch(deps, chainId, id, {
            status: v.status,
            verification: v.verification,
            error: v.status === "needs_attention" ? fail("verification_failed", v.verification.note ?? "Verification failed") : null,
          });
        }
      }
      return;
    }
  }
}

/** Verifies a Safe deployed inside an atomic batch, exactly as a standalone deployment is verified. */
async function settleBatchedDeployment(deps: ExecutorDeps, chainId: number, actionId: string, block: bigint, reverted: boolean) {
  const c = chainOf(deps, chainId);
  phase(deps, chainId, "verifying_safe");
  const insp = await inspectSafe(deps.clientFor(chainId), c.safeAddress, block);
  deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
  if (!insp.hasCode) {
    patch(
      deps,
      chainId,
      actionId,
      reverted
        ? { status: "failed", error: fail("reverted", "Batch reverted onchain. The Safe was not deployed and nothing moved.") }
        : { status: "needs_attention", error: fail("verification_failed", `Batch confirmed but no contract was found at ${c.safeAddress}.`) },
    );
    return;
  }
  const issues = compareSafeToConfig(insp, deps.getMigration().safeConfig, c.contracts);
  if (issues.length) {
    patch(deps, chainId, actionId, { status: "needs_attention", error: fail("verification_failed", issues.join(" ")) });
    log(deps, chainId, "error", `Safe at ${c.safeAddress} does not match the expected configuration: ${issues.join(" ")}`, { actionId });
    return;
  }
  patch(deps, chainId, actionId, { status: "verified" });
  log(deps, chainId, "info", `Safe deployed in the batch and verified at ${c.safeAddress}.`, { actionId });
}

/* ------------------------------- Deployment -------------------------------- */

async function runDeployment(deps: ExecutorDeps, chainId: number): Promise<boolean> {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const deploy = c.actions.find((a) => a.kind === "deploy_safe");
  if (!deploy) return false;

  if (SUCCESS_STATUSES.has(deploy.status) && deploy.status !== "skipped") return true;

  const insp = await inspectSafe(client, c.safeAddress);
  if (insp.hasCode) {
    const issues = destinationIssues(insp, m, c);
    deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
    if (issues.length) {
      if (deploy.status === "planned" || deploy.status === "skipped") {
        patch(deps, chainId, deploy.id, { status: "needs_attention", error: fail("verification_failed", issues.join(" ")) });
      }
      phase(deps, chainId, "failed", `Contract at ${c.safeAddress} does not match the expected Safe: ${issues.join(" ")} Transfers are blocked.`);
      return false;
    }
    if (deploy.status === "planned") {
      patch(deps, chainId, deploy.id, {
        status: "verified",
        verification: { expected: "0", safeDelta: null, sourceRemaining: null, note: "Safe already deployed with the expected configuration.", blockNumber: insp.blockNumber },
      });
    }
    return true;
  }
  if (deploy.status === "skipped") {
    // Planned as "already deployed" but there is no code now (e.g. RPC inconsistency).
    phase(deps, chainId, "failed", "Expected an existing Safe but no code was found. Re-plan the migration.");
    return false;
  }
  if (deploy.status !== "planned") {
    phase(deps, chainId, "needs_attention", deploy.error?.message ?? "Deployment needs attention.");
    return false;
  }

  await ensureWallet(deps, chainId);
  phase(deps, chainId, "deploying_safe");
  let tx;
  let gas: bigint;
  let fee: FeeQuote;
  try {
    tx = await buildDeploymentTransaction(chainId, client, m.safeConfig, c.safeVersion, c.contracts);
    const target = await deploymentTargetAddress(client, tx);
    if (target.toLowerCase() !== c.safeAddress.toLowerCase()) {
      throw new Error(`Deployment would create ${target}, not the verified Safe address ${c.safeAddress}.`);
    }
    fee = await getFeeQuote(client);
    gas = await estimateCallGas(client, m.source, tx);
  } catch (e) {
    patch(deps, chainId, deploy.id, { status: "failed", error: fail("simulation_failed", errorMessage(e)) });
    phase(deps, chainId, "failed", `Deployment simulation failed: ${errorMessage(e)}`);
    return false;
  }
  const l1 = await estimateL1DataFee(client, chainId, m.source, tx);
  const balance = await client.getBalance({ address: m.source });
  if (balance < maxCost(gas, fee, l1)) {
    phase(deps, chainId, "needs_attention", `Insufficient ${getChain(chainId).nativeSymbol} to deploy the Safe. Top up and Retry.`);
    return false;
  }
  const nonce = await client.getTransactionCount({ address: m.source, blockTag: "pending" });
  patch(deps, chainId, deploy.id, { status: "awaiting_wallet", gasLimit: gas.toString(), feeEstimate: maxCost(gas, fee, l1).toString() });
  phase(deps, chainId, "deploying_safe", "Confirm the Safe deployment in your wallet.");
  let hash: Hex;
  try {
    hash = await deps.wallet.sendTransaction({ chainId, ...tx, gas, ...feeFields(fee) });
  } catch (e) {
    await handleSendError(deps, chainId, [deploy.id], e, "Safe deployment");
    phase(deps, chainId, "failed", `Deployment could not be sent: ${errorMessage(e)}`);
    return false;
  }
  patch(deps, chainId, deploy.id, { status: "submitted", txHash: hash, txNonce: nonce, submittedAt: Date.now(), attempts: deploy.attempts + 1 });
  log(deps, chainId, "info", "Safe deployment submitted.", { actionId: deploy.id, txHash: hash });
  phase(deps, chainId, "deploying_safe", "Waiting for the deployment to confirm.");
  try {
    const { receipt, cancelled } = await waitReceipt(deps, chainId, deploy.id, hash);
    await settleReceipt(deps, chainId, deploy.id, receipt, cancelled);
  } catch (e) {
    if (e instanceof ReceiptTimeout) {
      phase(deps, chainId, "needs_attention", "Deployment is still pending. Resume later to reconcile.");
      throw new HaltRun("pending");
    }
    throw e;
  }
  return actionOf(deps, chainId, deploy.id).status === "verified";
}

/* -------------------------------- Transfers -------------------------------- */

interface Prepared {
  id: string;
  gas: bigint;
  l1: bigint;
}

async function prepareTransfers(deps: ExecutorDeps, chainId: number): Promise<Prepared[]> {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const ready: Prepared[] = [];
  const transfers = c.actions.filter((a) => a.kind !== "deploy_safe" && a.kind !== "transfer_native" && a.status === "planned");

  for (const a of transfers) {
    const refreshed = await refreshTransferAmounts(client, a, m.source, c.safeAddress);
    if (refreshed.alreadyInSafe) {
      patch(deps, chainId, a.id, {
        status: "verified",
        verification: { expected: "1", safeDelta: "1", sourceRemaining: "0", note: "Already held by the Safe (reconciled onchain).", blockNumber: null },
      });
      continue;
    }
    if (refreshed.nothingToMove) {
      if (refreshed.alreadyInSafe) {
        patch(deps, chainId, a.id, {
          status: "verified",
          verification: {
            expected: a.amounts.reduce((s, x) => s + BigInt(x), 0n).toString(),
            safeDelta: "1",
            sourceRemaining: "0",
            note: "Already held by the Safe.",
            blockNumber: null,
            evidence: "end_state",
          },
        });
      } else {
        patch(deps, chainId, a.id, {
          status: "skipped",
          verification: {
            expected: a.amounts.reduce((s, x) => s + BigInt(x), 0n).toString(),
            safeDelta: null,
            sourceRemaining: "0",
            note: "Source no longer holds this asset; nothing to move.",
            blockNumber: null,
            evidence: "end_state",
          },
        });
      }
      continue;
    }
    const preview = a.previewAmounts ?? a.amounts;
    if (amountsMateriallyChanged(preview, refreshed.amounts)) {
      patch(deps, chainId, a.id, {
        status: "needs_attention",
        amounts: refreshed.amounts,
        error: fail("amount_changed", "The amount to move changed since you reviewed the migration. Accept the new amount or go back to Review."),
      });
      continue;
    }
    const adapter = adapterFor(a);
    if (a.protocol) {
      const check = adapter ? await adapter.recheck({ chainId, source: m.source, action: a, client }) : { ok: false as const, reason: "Unknown protocol adapter." };
      if (!check.ok) {
        patch(deps, chainId, a.id, { status: "needs_attention", error: fail("blocked", check.reason) });
        log(deps, chainId, "warn", `${a.label}: ${check.reason}`, { actionId: a.id });
        continue;
      }
    }
    const updated: MigrationAction =
      a.kind === "transfer_erc1155" ? { ...a, ...pruneZeroErc1155(a, refreshed.amounts) } : { ...a, amounts: refreshed.amounts };
    const call = buildTransferCall(updated, m.source, c.safeAddress);
    const sim = await simulateTransfer(client, m.source, updated, call);
    if (!sim.ok) {
      patch(deps, chainId, a.id, { status: "failed", amounts: updated.amounts, tokenIds: updated.tokenIds, error: fail("simulation_failed", sim.reason) });
      log(deps, chainId, "warn", `${a.label}: ${sim.reason}`, { actionId: a.id });
      continue;
    }
    try {
      const gas = await estimateCallGas(client, m.source, call);
      const l1 = await estimateL1DataFee(client, chainId, m.source, call);
      patch(deps, chainId, a.id, { amounts: updated.amounts, tokenIds: updated.tokenIds, gasLimit: gas.toString() });
      ready.push({ id: a.id, gas, l1 });
    } catch (e) {
      patch(deps, chainId, a.id, { status: "failed", error: fail("simulation_failed", errorMessage(e)) });
    }
  }
  return ready;
}

/** Native amount computed from a fresh balance, reserving every fee that still has to be paid. */
async function computeNative(deps: ExecutorDeps, chainId: number, otherCosts: bigint, fee: FeeQuote) {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const native = c.actions.find((a) => a.kind === "transfer_native" && a.status === "planned");
  if (!native) return null;
  const probe = { to: c.safeAddress, data: "0x" as const, value: 1n };
  const gas = await estimateCallGas(client, m.source, probe);
  const l1 = await estimateL1DataFee(client, chainId, m.source, probe);
  const own = maxCost(gas, fee, l1);
  const balance = await client.getBalance({ address: m.source });
  const amount = spendableNative(balance, otherCosts + own);
  if (isDust(amount, own)) {
    patch(deps, chainId, native.id, {
      status: "skipped",
      amounts: ["0"],
      verification: {
        expected: "0",
        safeDelta: null,
        sourceRemaining: balance.toString(),
        note: "Remaining balance after gas reserve is dust; left in the source wallet.",
        blockNumber: null,
      },
    });
    return null;
  }
  patch(deps, chainId, native.id, { amounts: [amount.toString()], gasLimit: gas.toString(), feeEstimate: own.toString() });
  return { id: native.id, gas, l1, amount };
}

async function snapshotSafe(deps: ExecutorDeps, chainId: number, ids: string[]) {
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  for (const id of ids) {
    const a = actionOf(deps, chainId, id);
    patch(deps, chainId, id, { safeBalancesBefore: await readSafeBalances(client, a, c.safeAddress) });
  }
}

async function runSequential(deps: ExecutorDeps, chainId: number, ready: Prepared[]) {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);

  const queue = [...ready.map((r) => ({ ...r, native: false }))];
  const hasNative = c.actions.some((a) => a.kind === "transfer_native" && a.status === "planned");
  if (hasNative) queue.push({ id: "__native__", gas: 0n, l1: 0n, native: true });

  for (const item of queue) {
    if (deps.shouldStop()) {
      phase(deps, chainId, "needs_attention", "Paused. Resume to continue.");
      throw new HaltRun("paused");
    }
    let fee = await getFeeQuote(client);
    let id = item.id;
    let gas = item.gas;
    if (item.native) {
      // Recalculated right before the final native transfer.
      const n = await computeNative(deps, chainId, 0n, fee);
      if (!n) continue;
      id = n.id;
      gas = n.gas;
    } else {
      const balance = await client.getBalance({ address: m.source });
      if (balance < maxCost(gas, fee, item.l1)) {
        patch(deps, chainId, id, { status: "failed", error: fail("insufficient_gas", "Not enough native balance for this transfer's gas. Top up and Retry.") });
        continue;
      }
    }
    await snapshotSafe(deps, chainId, [id]);
    const a = actionOf(deps, chainId, id);
    const call = buildTransferCall(a, m.source, c.safeAddress);
    const nonce = await client.getTransactionCount({ address: m.source, blockTag: "pending" });
    phase(deps, chainId, "awaiting_approval", `Approve "${a.label}" in your wallet.`);
    patch(deps, chainId, id, { status: "awaiting_wallet" });
    let hash: Hex;
    try {
      fee = item.native ? fee : await getFeeQuote(client);
      hash = await deps.wallet.sendTransaction({ chainId, ...call, gas, ...feeFields(fee) });
    } catch (e) {
      await handleSendError(deps, chainId, [id], e, a.label);
      continue;
    }
    patch(deps, chainId, id, { status: "submitted", txHash: hash, txNonce: nonce, submittedAt: Date.now(), attempts: a.attempts + 1 });
    log(deps, chainId, "info", `${a.label} submitted.`, { actionId: id, txHash: hash });
    phase(deps, chainId, "confirming", `Waiting for "${a.label}" to confirm.`);
    try {
      const { receipt, cancelled } = await waitReceipt(deps, chainId, id, hash);
      await settleReceipt(deps, chainId, id, receipt, cancelled);
    } catch (e) {
      if (e instanceof ReceiptTimeout) {
        phase(deps, chainId, "needs_attention", `"${a.label}" is still pending. Resume later to reconcile.`);
        throw new HaltRun("pending");
      }
      patch(deps, chainId, id, { status: "needs_attention", error: fail("rpc_error", errorMessage(e)) });
    }
  }
}

interface BatchedDeployment extends Prepared {
  call: BatchCall;
}

/**
 * Sends the chain's token transfers as one atomicRequired EIP-5792 batch. With `deployment`, the
 * Safe deployment is the first call of the same batch: atomicity means the transfers can only land
 * if that exact CREATE2 deployment succeeds, and the Safe is verified onchain right after.
 *
 * The native remainder is never part of a batch: the wallet picks the batch's gas limit and fee, so
 * "balance minus our reserve" can exceed what is left and revert everything. It is sent afterwards,
 * sized from the post-batch balance (see runChain).
 */
async function runAtomic(deps: ExecutorDeps, chainId: number, ready: Prepared[], deployment?: BatchedDeployment): Promise<"done" | "fallback" | "halted"> {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const fee = await getFeeQuote(client);
  const batchCost = [...ready, ...(deployment ? [deployment] : [])].reduce((s, r) => s + maxCost(r.gas, fee, r.l1), 0n);
  const balance = await client.getBalance({ address: m.source });
  if (balance < batchCost) {
    phase(deps, chainId, "needs_attention", `Insufficient ${getChain(chainId).nativeSymbol} for the batch's gas. Top up and Retry.`);
    return "halted";
  }
  const transferIds = ready.map((r) => r.id);
  if (!transferIds.length) return "done";
  await snapshotSafe(deps, chainId, transferIds);
  const ids = [...(deployment ? [deployment.id] : []), ...transferIds];
  const calls = [
    ...(deployment ? [deployment.call] : []),
    ...transferIds.map((id) => buildTransferCall(actionOf(deps, chainId, id), m.source, c.safeAddress)),
  ];

  const provider = await deps.wallet.provider(chainId);
  const what = `${transferIds.length} transfer${transferIds.length > 1 ? "s" : ""}`;
  phase(
    deps,
    chainId,
    "awaiting_approval",
    deployment ? `Approve the Safe deployment and ${what} as one atomic batch in your wallet.` : `Approve ${what} as one atomic batch in your wallet.`,
  );
  for (const id of ids) patch(deps, chainId, id, { status: "awaiting_wallet" });
  let callsId: string;
  try {
    callsId = await sendAtomicBatch(provider, chainId, m.source, calls);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 5750) {
      for (const id of ids) patch(deps, chainId, id, { status: "rejected", error: fail("user_rejected", "Account upgrade for batching was declined.") });
      phase(deps, chainId, "needs_attention", "You declined the wallet's batching upgrade. Switch this network to one-by-one transactions and Retry.");
      throw new HaltRun("upgrade rejected");
    }
    if (isUserRejection(e)) await handleSendError(deps, chainId, ids, e, deployment ? "The deployment and transfer batch" : "The transfer batch");
    const cls = classifySubmissionError(e);
    if (cls === "ambiguous") {
      await markUncertain(deps, chainId, ids, `Batch submission outcome unknown (${errorMessage(e)}).`);
      phase(deps, chainId, "needs_attention", "The batch may have been submitted. Resume to reconcile before retrying.");
      throw new HaltRun("ambiguous batch");
    }
    if (cls !== "not_submitted") {
      await markUncertain(deps, chainId, ids, `Batch failed with an unclear outcome (${errorMessage(e)}).`);
      phase(deps, chainId, "needs_attention", "Batch outcome unclear. Resume to reconcile.");
      throw new HaltRun("batch unclear");
    }
    for (const id of ids) patch(deps, chainId, id, { status: "planned" });
    log(deps, chainId, "warn", `Atomic batch unavailable (${errorMessage(e)}); falling back to sequential transactions.`);
    deps.dispatch({ type: "SET_STRATEGY", chainId, strategy: "sequential" });
    return "fallback";
  }
  deps.dispatch({
    type: "BATCH_RECORD",
    chainId,
    batch: { callsId, actionIds: ids, submittedAt: Date.now(), statusCode: null, atomic: null, transactionHashes: [] },
  });
  for (const id of ids) {
    const a = actionOf(deps, chainId, id);
    patch(deps, chainId, id, { status: "submitted", callsId, submittedAt: Date.now(), attempts: a.attempts + 1 });
  }
  log(deps, chainId, "info", `Atomic batch submitted (${ids.length} calls${deployment ? ", including the Safe deployment" : ""}).`);
  phase(deps, chainId, "confirming", "Waiting for the batch to confirm.");
  const outcome = await waitForCallsStatus(provider, callsId, { timeoutMs: deps.batchTimeoutMs });
  await applyBatchOutcome(deps, chainId, callsId, ids, outcome, false);
  return "done";
}

/** Blocks new sends while earlier transactions from the source are still pending (nonce safety). */
async function blockedByPendingTransactions(deps: ExecutorDeps, chainId: number): Promise<boolean> {
  const client = deps.clientFor(chainId);
  const source = deps.getMigration().source;
  const latest = await client.getTransactionCount({ address: source, blockTag: "latest" });
  const pendingNonce = await client.getTransactionCount({ address: source, blockTag: "pending" });
  if (pendingNonce <= latest) return false;
  phase(deps, chainId, "needs_attention", "Your wallet has pending transactions on this network. Wait for them to confirm, then Resume.");
  return true;
}

/**
 * Atomic-batch chains whose Safe is not deployed yet: deployment + transfers in ONE wallet prompt.
 * Returns "skip" when this path does not apply, so the regular deploy-then-transfer flow runs.
 */
async function runDeploymentInBatch(deps: ExecutorDeps, chainId: number): Promise<"skip" | "done"> {
  const m = deps.getMigration();
  const c = chainOf(deps, chainId);
  const client = deps.clientFor(chainId);
  const deploy = c.actions.find((a) => a.kind === "deploy_safe");
  if (c.strategy !== "atomic_batch" || deploy?.status !== "planned") return "skip";
  if (!c.actions.some((a) => a.kind !== "deploy_safe" && a.status === "planned")) return "skip";
  if ((await inspectSafe(client, c.safeAddress)).hasCode) return "skip";

  await ensureWallet(deps, chainId);
  if (await blockedByPendingTransactions(deps, chainId)) return "done";

  phase(deps, chainId, "deploying_safe", "Preparing the Safe deployment for the batch.");
  let deployment: BatchedDeployment;
  try {
    const tx = await buildDeploymentTransaction(chainId, client, m.safeConfig, c.safeVersion, c.contracts);
    const target = await deploymentTargetAddress(client, tx);
    if (target.toLowerCase() !== c.safeAddress.toLowerCase()) {
      throw new Error(`Deployment would create ${target}, not the verified Safe address ${c.safeAddress}.`);
    }
    const gas = await estimateCallGas(client, m.source, tx);
    const l1 = await estimateL1DataFee(client, chainId, m.source, tx);
    deployment = { id: deploy.id, gas, l1, call: tx };
    patch(deps, chainId, deploy.id, { gasLimit: gas.toString() });
  } catch (e) {
    patch(deps, chainId, deploy.id, { status: "failed", error: fail("simulation_failed", errorMessage(e)) });
    phase(deps, chainId, "failed", `Deployment simulation failed: ${errorMessage(e)}`);
    return "done";
  }

  phase(deps, chainId, "preparing_transfers");
  const ready = await prepareTransfers(deps, chainId);
  if (!ready.length) return "skip";
  phase(deps, chainId, "transferring");
  const r = await runAtomic(deps, chainId, ready, deployment);
  if (r === "fallback") return "skip";
  if (actionOf(deps, chainId, deploy.id).status === "verified") await sendNativeRemainder(deps, chainId);
  return "done";
}

/** The final native transfer, only ever into a Safe that is deployed and verified. */
async function sendNativeRemainder(deps: ExecutorDeps, chainId: number) {
  if (!chainOf(deps, chainId).actions.some((a) => a.kind === "transfer_native" && a.status === "planned")) return;
  await runSequential(deps, chainId, []);
}

/* --------------------------------- Runner --------------------------------- */

/** Summarizes the chain unless a more specific halt message is already shown. */
function settleChain(deps: ExecutorDeps, chainId: number) {
  const p = chainOf(deps, chainId).phase;
  if (p !== "failed" && p !== "needs_attention") finalizeChain(deps, chainId);
}

function finalizeChain(deps: ExecutorDeps, chainId: number) {
  const c = chainOf(deps, chainId);
  const outcome = chainOutcome(c);
  if (outcome === "completed") phase(deps, chainId, "completed", null);
  else if (outcome === "needs_attention") {
    const failed = c.actions.filter((a) => !SUCCESS_STATUSES.has(a.status));
    phase(deps, chainId, "needs_attention", `${failed.length} action(s) need attention: ${failed.map((a) => a.label).join(", ")}.`);
  }
}

export async function runChain(deps: ExecutorDeps, chainId: number): Promise<void> {
  const m = deps.getMigration();
  const gate = executionGate(chainId);
  if (!gate.enabled) {
    phase(deps, chainId, "needs_attention", gate.reason);
    return;
  }

  // Reconciling in-flight work is read-only and always allowed; sending anything new needs owner readiness.
  await reconcileChain(deps, chainId);
  if (chainOutcome(chainOf(deps, chainId)) === "completed") {
    phase(deps, chainId, "completed");
    return;
  }

  const readiness = await validateMigrationOwnerProofs(m, deps.clientFor, chainId);
  if (!readiness.ok) {
    phase(deps, chainId, "needs_attention", readiness.issues.join(" "));
    log(deps, chainId, "error", `Owner verification blocks this network: ${readiness.issues.join(" ")}`);
    return;
  }
  if (readiness.issues.length) log(deps, chainId, "warn", `Owner verification notes: ${readiness.issues.join(" ")}`);

  if ((await runDeploymentInBatch(deps, chainId)) === "done") {
    settleChain(deps, chainId);
    return;
  }

  const deployed = await runDeployment(deps, chainId);
  if (!deployed) {
    settleChain(deps, chainId);
    return;
  }

  // Re-verify the live Safe immediately before moving assets into it.
  const client = deps.clientFor(chainId);
  const c = chainOf(deps, chainId);
  const insp = await inspectSafe(client, c.safeAddress);
  const issues = destinationIssues(insp, m, c);
  deps.dispatch({ type: "CHAIN_PATCH", chainId, patch: { safeVerification: insp } });
  if (issues.length) {
    phase(deps, chainId, "failed", `Safe verification failed; transfers blocked: ${issues.join(" ")}`);
    return;
  }

  const pending = c.actions.filter((a) => a.kind !== "deploy_safe" && a.status === "planned");
  if (pending.length === 0) {
    finalizeChain(deps, chainId);
    return;
  }

  await ensureWallet(deps, chainId);
  if (await blockedByPendingTransactions(deps, chainId)) return;

  phase(deps, chainId, "preparing_transfers");
  const ready = await prepareTransfers(deps, chainId);
  phase(deps, chainId, "transferring");
  if (chainOf(deps, chainId).strategy === "atomic_batch") {
    const r = await runAtomic(deps, chainId, ready);
    if (r === "fallback") await runSequential(deps, chainId, ready);
    else if (r === "done") await sendNativeRemainder(deps, chainId);
  } else {
    await runSequential(deps, chainId, ready);
  }
  settleChain(deps, chainId);
}

export async function runMigration(deps: ExecutorDeps): Promise<void> {
  deps.dispatch({ type: "RUN_STATE", runState: "running" });
  try {
    for (const c of deps.getMigration().chains) {
      if (deps.shouldStop()) break;
      const current = chainOf(deps, c.chainId);
      if (chainOutcome(current) === "completed") {
        if (current.phase !== "completed") phase(deps, c.chainId, "completed");
        continue;
      }
      try {
        await runChain(deps, c.chainId);
      } catch (e) {
        if (e instanceof HaltRun) {
          log(deps, c.chainId, "warn", `Run stopped: ${e.message}`);
          break;
        }
        phase(deps, c.chainId, "failed", `Unexpected error: ${errorMessage(e)}`);
        log(deps, c.chainId, "error", errorMessage(e));
      }
    }
  } finally {
    const m = deps.getMigration();
    const allDone = m.chains.every((c) => chainOutcome(c) === "completed");
    deps.dispatch({ type: "RUN_STATE", runState: allDone ? "finished" : "paused" });
  }
}
