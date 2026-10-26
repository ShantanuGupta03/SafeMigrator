import type {
  ActionStatus,
  BatchRecord,
  ChainMigration,
  ChainPhase,
  ExecutionStrategy,
  Migration,
  MigrationAction,
  MigrationLogEntry,
} from "@/lib/domain/types";

/**
 * `uncertain` deliberately has no edge back to `planned`: only CONFIRM_NOT_SENT (an explicit user
 * decision, allowed when no broadcast was detected) can make an uncertain action sendable again.
 */
export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  planned: ["awaiting_wallet", "submitted", "verifying", "verified", "skipped", "failed", "needs_attention"],
  awaiting_wallet: ["submitted", "rejected", "failed", "planned", "needs_attention", "uncertain"],
  submitted: ["submitted", "verifying", "failed", "needs_attention", "uncertain"],
  verifying: ["verified", "verified_with_discrepancy", "needs_attention", "failed", "uncertain", "skipped"],
  verified: [],
  verified_with_discrepancy: [],
  skipped: ["planned"],
  rejected: ["planned"],
  failed: ["planned"],
  needs_attention: ["planned", "verifying", "verified", "verified_with_discrepancy", "failed", "skipped", "uncertain"],
  uncertain: ["uncertain", "submitted", "verifying", "verified", "verified_with_discrepancy", "failed", "needs_attention"],
};

export const SUCCESS_STATUSES: ReadonlySet<ActionStatus> = new Set(["verified", "verified_with_discrepancy", "skipped"]);
export const RETRYABLE_STATUSES: ReadonlySet<ActionStatus> = new Set(["failed", "rejected", "needs_attention"]);
export const IN_FLIGHT_STATUSES: ReadonlySet<ActionStatus> = new Set(["submitted", "verifying"]);

/** Anything that could still land onchain: in flight, waiting in the wallet, or of unknown outcome. */
export function hasInFlightActions(m: Migration): boolean {
  return m.chains.some((c) => c.actions.some((a) => IN_FLIGHT_STATUSES.has(a.status) || a.status === "awaiting_wallet" || a.status === "uncertain"));
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return from === to || ACTION_TRANSITIONS[from].includes(to);
}

export type MigrationEvent =
  | { type: "HYDRATE"; migration: Migration | null }
  | { type: "CREATE"; migration: Migration }
  | { type: "RESET" }
  | { type: "RUN_STATE"; runState: Migration["runState"] }
  | { type: "CHAIN_PATCH"; chainId: number; patch: Partial<Pick<ChainMigration, "phase" | "message" | "strategy" | "safeVerification">> }
  | { type: "ACTION_PATCH"; chainId: number; actionId: string; patch: Partial<MigrationAction> }
  | { type: "BATCH_RECORD"; chainId: number; batch: BatchRecord }
  | { type: "BATCH_PATCH"; chainId: number; callsId: string; patch: Partial<BatchRecord> }
  | { type: "LOG"; entry: Omit<MigrationLogEntry, "at"> & { at?: number } }
  | { type: "RETRY_FAILED"; chainId?: number }
  /** User decision after reviewing the evidence: these uncertain actions were never broadcast. */
  | { type: "CONFIRM_NOT_SENT"; chainId: number; actionIds: string[] }
  /** User re-confirms the current amount after a material change since review. */
  | { type: "ACCEPT_AMOUNTS"; chainId: number; actionId: string }
  | { type: "SET_STRATEGY"; chainId: number; strategy: ExecutionStrategy };

const MAX_LOG = 400;

function withLog(m: Migration, entry: Omit<MigrationLogEntry, "at"> & { at?: number }): Migration {
  const log = [...m.log, { ...entry, at: entry.at ?? Date.now() }];
  return { ...m, log: log.length > MAX_LOG ? log.slice(-MAX_LOG) : log };
}

function mapChain(m: Migration, chainId: number, fn: (c: ChainMigration) => ChainMigration): Migration {
  return { ...m, chains: m.chains.map((c) => (c.chainId === chainId ? fn(c) : c)) };
}

export function migrationReducer(state: Migration | null, event: MigrationEvent): Migration | null {
  switch (event.type) {
    case "HYDRATE":
      return event.migration;
    case "CREATE":
      return event.migration;
    case "RESET":
      return null;
  }
  if (!state) return state;
  const now = Date.now();
  let next: Migration = state;

  switch (event.type) {
    case "RUN_STATE":
      next = { ...state, runState: event.runState };
      break;
    case "CHAIN_PATCH":
      next = mapChain(state, event.chainId, (c) => ({ ...c, ...event.patch }));
      break;
    case "SET_STRATEGY":
      next = mapChain(state, event.chainId, (c) => ({ ...c, strategy: event.strategy }));
      break;
    case "ACTION_PATCH": {
      let rejected: string | null = null;
      next = mapChain(state, event.chainId, (c) => ({
        ...c,
        actions: c.actions.map((a) => {
          if (a.id !== event.actionId) return a;
          if (event.patch.status && !canTransition(a.status, event.patch.status)) {
            rejected = `Ignored invalid transition ${a.status} → ${event.patch.status} for ${a.id}`;
            return a;
          }
          return { ...a, ...event.patch };
        }),
      }));
      if (rejected) next = withLog(state, { chainId: event.chainId, actionId: event.actionId, level: "error", message: rejected });
      break;
    }
    case "BATCH_RECORD":
      next = mapChain(state, event.chainId, (c) => ({ ...c, batches: [...c.batches, event.batch] }));
      break;
    case "BATCH_PATCH":
      next = mapChain(state, event.chainId, (c) => ({
        ...c,
        batches: c.batches.map((b) => (b.callsId === event.callsId ? { ...b, ...event.patch } : b)),
      }));
      break;
    case "LOG":
      next = withLog(state, event.entry);
      break;
    case "RETRY_FAILED":
      next = {
        ...state,
        runState: "idle",
        chains: state.chains.map((c) => {
          if (event.chainId !== undefined && c.chainId !== event.chainId) return c;
          const actions = c.actions.map((a) =>
            isSafelyRetryable(a)
              ? { ...a, status: "planned" as const, error: null, callsId: null, txHash: null, txNonce: null, verification: null, uncertainty: null }
              : a,
          );
          const changed = actions.some((a, i) => a !== c.actions[i]);
          return changed || c.phase === "failed" || c.phase === "needs_attention"
            ? { ...c, actions, phase: "idle" as ChainPhase, message: null }
            : c;
        }),
      };
      break;
    case "CONFIRM_NOT_SENT": {
      const ids = new Set(event.actionIds);
      const confirmed: string[] = [];
      next = mapChain(state, event.chainId, (c) => ({
        ...c,
        phase: "idle",
        message: null,
        actions: c.actions.map((a) => {
          if (!ids.has(a.id) || a.status !== "uncertain" || !a.uncertainty?.userMayConfirmNotSent) return a;
          confirmed.push(a.label);
          return { ...a, status: "planned" as const, error: null, callsId: null, txHash: null, txNonce: null, uncertainty: null, promptBlock: null };
        }),
      }));
      if (confirmed.length) {
        next = withLog(next, {
          chainId: event.chainId,
          actionId: null,
          level: "warn",
          message: `You confirmed that ${confirmed.join(", ")} ${confirmed.length > 1 ? "were" : "was"} never sent; ${confirmed.length > 1 ? "they" : "it"} will be prompted again.`,
        });
      }
      break;
    }
    case "ACCEPT_AMOUNTS":
      next = mapChain(state, event.chainId, (c) => ({
        ...c,
        phase: "idle",
        message: null,
        actions: c.actions.map((a) =>
          a.id === event.actionId && a.status === "needs_attention" && a.error?.code === "amount_changed"
            ? { ...a, status: "planned" as const, error: null, previewAmounts: a.amounts, previewTokenIds: a.tokenIds }
            : a,
        ),
      }));
      break;
  }
  return { ...next, updatedAt: now };
}

/* -------------------------------- Derived -------------------------------- */

export type ChainOutcome = "not_started" | "in_progress" | "completed" | "needs_attention" | "blocked";

export function chainOutcome(c: ChainMigration): ChainOutcome {
  if (c.actions.every((a) => SUCCESS_STATUSES.has(a.status))) return "completed";
  if (c.actions.some((a) => a.status === "failed" || a.status === "rejected" || a.status === "needs_attention" || a.status === "uncertain")) {
    return "needs_attention";
  }
  if (c.phase === "failed" || c.phase === "needs_attention") return "needs_attention";
  if (c.actions.every((a) => a.status === "planned")) return "not_started";
  return "in_progress";
}

export function migrationProgress(m: Migration) {
  const actions = m.chains.flatMap((c) => c.actions);
  const done = actions.filter((a) => SUCCESS_STATUSES.has(a.status)).length;
  const attention = actions.filter((a) => RETRYABLE_STATUSES.has(a.status)).length;
  const uncertain = actions.filter((a) => a.status === "uncertain").length;
  const inFlight = actions.filter((a) => IN_FLIGHT_STATUSES.has(a.status) || a.status === "awaiting_wallet").length;
  return {
    total: actions.length,
    done,
    attention,
    uncertain,
    inFlight,
    complete: actions.length > 0 && done === actions.length,
  };
}

export type MigrationOutcome =
  /** Every selected asset on every selected network was migrated and verified. */
  | "complete"
  /** Everything that could run finished, but part of the selection was blocked or excluded. */
  | "partial"
  /** Some executable steps have not finished (failed, rejected, pending or not started). */
  | "incomplete"
  /** At least one step has an unknown outcome and needs reconciliation or a user decision. */
  | "uncertain";

/** Outcome against the user's original selection, not just the executable subset. */
export function migrationOutcome(m: Migration): { outcome: MigrationOutcome; scopeKnown: boolean; blockedChains: number; excludedAssets: number } {
  const scope = m.scope ?? null;
  const blockedChains = scope?.blockedChains.length ?? 0;
  const excludedAssets = scope?.excludedAssets.length ?? 0;
  const actions = m.chains.flatMap((c) => c.actions);
  let outcome: MigrationOutcome;
  if (actions.some((a) => a.status === "uncertain")) outcome = "uncertain";
  else if (m.chains.length === 0 || m.chains.some((c) => chainOutcome(c) !== "completed")) outcome = "incomplete";
  else if (blockedChains > 0 || excludedAssets > 0) outcome = "partial";
  else outcome = "complete";
  return { outcome, scopeKnown: !!scope, blockedChains, excludedAssets };
}

/**
 * An action may be reset to `planned` only when nothing it sent can still land onchain: it was
 * never broadcast, its transaction/batch reverted or failed offchain, or its nonce was consumed by
 * another transaction. Uncertain actions and amount changes need an explicit user decision instead.
 */
export function isSafelyRetryable(a: MigrationAction): boolean {
  if (!RETRYABLE_STATUSES.has(a.status)) return false;
  if (a.error?.code === "amount_changed" || a.error?.code === "submission_unknown") return false;
  if (!a.txHash && !a.callsId) return true;
  return (
    a.error?.code === "reverted" ||
    a.error?.code === "batch_failed" ||
    a.error?.code === "simulation_failed" ||
    a.error?.code === "not_landed"
  );
}

export function canConfirmNotSent(a: MigrationAction): boolean {
  return a.status === "uncertain" && !!a.uncertainty?.userMayConfirmNotSent;
}

export function hasRetryable(m: Migration): boolean {
  return m.chains.some((c) => c.actions.some(isSafelyRetryable));
}
