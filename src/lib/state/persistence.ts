import type { Address } from "viem";
import type { Migration } from "@/lib/domain/types";
import type { ManualImport } from "@/lib/services/discovery/asset-discovery";
import { hasInFlightActions } from "./machine";

const PREFIX = "safe-migrator:v1";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function migrationKey(source: Address): string {
  return `${PREFIX}:migration:${source.toLowerCase()}`;
}

export function draftKey(source: Address): string {
  return `${PREFIX}:draft:${source.toLowerCase()}`;
}

export function testnetAssetsKey(account: string): string {
  return `${PREFIX}:testnet-assets:${account.toLowerCase()}`;
}

export interface TestnetDeployment {
  chainId: number;
  txHash: `0x${string}`;
  imports: ManualImport[];
}

/** Manual imports for demo contracts the account deployed from the testnet tools page. */
export function loadTestnetImports(store: KeyValueStore, account: string): ManualImport[] {
  try {
    const list = JSON.parse(store.getItem(testnetAssetsKey(account)) ?? "[]") as Partial<TestnetDeployment>[];
    return Array.isArray(list) ? list.flatMap((d) => (Array.isArray(d.imports) ? d.imports : [])) : [];
  } catch {
    return [];
  }
}

/** Only non-sensitive data is persisted: addresses, amounts, tx hashes, statuses. Never keys. */
export function saveMigration(store: KeyValueStore, m: Migration): void {
  store.setItem(migrationKey(m.source), JSON.stringify(m));
}

export function clearMigration(store: KeyValueStore, source: Address): void {
  store.removeItem(migrationKey(source));
}

export function historyKey(source: Address): string {
  return `${PREFIX}:history:${source.toLowerCase()}`;
}

export const HISTORY_LIMIT = 10;

export function loadMigrationHistory(store: KeyValueStore, source: Address): Migration[] {
  try {
    const list = JSON.parse(store.getItem(historyKey(source)) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter(isMigration) : [];
  } catch {
    return [];
  }
}

/** Keeps a replaced migration's record (tx hashes, outcomes) instead of overwriting it. Newest first. */
export function archiveMigration(store: KeyValueStore, m: Migration): void {
  const rest = loadMigrationHistory(store, m.source).filter((x) => x.id !== m.id);
  try {
    store.setItem(historyKey(m.source), JSON.stringify([m, ...rest].slice(0, HISTORY_LIMIT)));
  } catch {
    // Storage quota: the history is a convenience; the active migration record is what matters.
  }
}

function isMigration(v: unknown): v is Migration {
  if (!v || typeof v !== "object") return false;
  const m = v as Partial<Migration>;
  return (
    m.schemaVersion === 1 &&
    typeof m.source === "string" &&
    Array.isArray(m.chains) &&
    !!m.safeConfig &&
    Array.isArray(m.safeConfig.owners) &&
    m.chains.every((c) => typeof c.chainId === "number" && Array.isArray(c.actions))
  );
}

/**
 * Loads a stored migration. If the previous session was interrupted mid-run, the migration is
 * marked paused: the executor must reconcile with chain state before doing anything else.
 */
export function loadMigration(store: KeyValueStore, source: Address): Migration | null {
  const raw = store.getItem(migrationKey(source));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isMigration(parsed)) return null;
  const m = parsed;
  if (m.runState === "running") {
    const inFlight = hasInFlightActions(m);
    return {
      ...m,
      runState: "paused",
      log: [
        ...m.log,
        {
          at: Date.now(),
          chainId: null,
          actionId: null,
          level: "warn",
          message: inFlight
            ? "Previous session was interrupted with transactions in flight. Resume to reconcile them with the chain."
            : "Previous session was interrupted. Resume to continue.",
        },
      ],
    };
  }
  return m;
}

export function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
