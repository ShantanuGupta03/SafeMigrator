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

export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  planned: ["awaiting_wallet", "submitted", "verifying", "verified", "skipped", "failed", "needs_attention"],
  awaiting_wallet: ["submitted", "rejected", "failed", "planned", "needs_attention"],
  submitted: ["submitted", "verifying", "failed", "needs_attention"],
  verifying: ["verified", "verified_with_discrepancy", "needs_attention", "failed"],
  verified: [],
  verified_with_discrepancy: [],
  skipped: ["planned"],
  rejected: ["planned"],
  failed: ["planned"],
  needs_attention: ["planned", "verifying", "verified", "verified_with_discrepancy", "failed", "skipped"],
};

export const SUCCESS_STATUSES: ReadonlySet<ActionStatus> = new Set(["verified", "verified_with_discrepancy", "skipped"]);
export const RETRYABLE_STATUSES: ReadonlySet<ActionStatus> = new Set(["failed", "rejected", "needs_attention"]);
export const IN_FLIGHT_STATUSES: ReadonlySet<ActionStatus> = new Set(["submitted", "verifying"]);

export function hasInFlightActions(m: Migration): boolean {
  return m.chains.some((c) => c.actions.some((a) => IN_FLIGHT_STATUSES.has(a.status) || a.status === "awaiting_wallet"));
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
              ? { ...a, status: "planned" as const, error: null, callsId: null, txHash: null, txNonce: null, verification: null }
              : a,
          );
          const changed = actions.some((a, i) => a !== c.actions[i]);
          return changed || c.phase === "failed" || c.phase === "needs_attention"
            ? { ...c, actions, phase: "idle" as ChainPhase, message: null }
            : c;
        }),
      };
      break;
  }
  return { ...next, updatedAt: now };
}

/* -------------------------------- Derived -------------------------------- */

export type ChainOutcome = "not_started" | "in_progress" | "completed" | "needs_attention" | "blocked";

export function chainOutcome(c: ChainMigration): ChainOutcome {
  if (c.actions.every((a) => SUCCESS_STATUSES.has(a.status))) return "completed";
  if (c.actions.some((a) => a.status === "failed" || a.status === "rejected" || a.status === "needs_attention")) {
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
  const inFlight = actions.filter((a) => IN_FLIGHT_STATUSES.has(a.status) || a.status === "awaiting_wallet").length;
  return {
    total: actions.length,
    done,
    attention,
    inFlight,
    complete: actions.length > 0 && done === actions.length,
  };
}

/**
 * An action may be reset to `planned` only when nothing it sent can still land onchain: it was
 * never broadcast, or its transaction/batch is known to have reverted or failed offchain.
 * Unknown outcomes (e.g. a dropped hash) must be reconciled via chain state instead.
 */
export function isSafelyRetryable(a: MigrationAction): boolean {
  if (!RETRYABLE_STATUSES.has(a.status)) return false;
  if (!a.txHash && !a.callsId) return true;
  return (
    a.error?.code === "reverted" ||
    a.error?.code === "batch_failed" ||
    a.error?.code === "simulation_failed" ||
    a.error?.code === "dropped"
  );
}

export function hasRetryable(m: Migration): boolean {
  return m.chains.some((c) => c.actions.some(isSafelyRetryable));
}
