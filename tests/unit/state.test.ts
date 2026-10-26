import { describe, expect, it } from "vitest";
import type { Migration, MigrationAction } from "@/lib/domain/types";
import { buildActions, createMigration } from "@/lib/services/migration-planning";
import { canTransition, chainOutcome, hasInFlightActions, hasRetryable, isSafelyRetryable, migrationProgress, migrationReducer } from "@/lib/state/machine";
import {
  archiveMigration,
  HISTORY_LIMIT,
  historyKey,
  loadMigration,
  loadMigrationHistory,
  loadTestnetImports,
  memoryStore,
  migrationKey,
  saveMigration,
  testnetAssetsKey,
} from "@/lib/state/persistence";
import { asset, CONFIG, contracts130, SAFE, SEPOLIA, SOURCE } from "./fixtures";

function migration(): Migration {
  const actions = buildActions(SEPOLIA, [asset({ standard: "erc20" }), asset({ standard: "native", balance: "10" })], true);
  return createMigration({
    id: "m1",
    source: SOURCE,
    environment: "testnet",
    safeConfig: CONFIG,
    verifiedOwners: [],
    plans: [
      {
        chainId: SEPOLIA,
        safeAddress: SAFE,
        safeVersion: "1.3.0",
        contracts: contracts130(),
        needsDeployment: true,
        strategy: "sequential",
        actions,
        excluded: [],
        costs: { deployMax: 0n, transfersMax: 0n, totalMax: 0n, totalTypical: 0n },
        nativeBalance: 10n,
        nativeReserve: 0n,
        nativeToSend: 10n,
        deficit: 0n,
        confirmations: { chainSwitch: 0, deployment: 1, transfers: 2, total: 3, deploymentInBatch: false, note: null },
        blockers: [],
        warnings: [],
        executable: true,
      },
    ],
  });
}

const patch = (m: Migration, actionId: string, p: Partial<MigrationAction>) => migrationReducer(m, { type: "ACTION_PATCH", chainId: SEPOLIA, actionId, patch: p })!;

describe("action state machine", () => {
  it("allows the happy path and forbids leaving terminal success", () => {
    expect(canTransition("planned", "awaiting_wallet")).toBe(true);
    expect(canTransition("awaiting_wallet", "submitted")).toBe(true);
    expect(canTransition("submitted", "verifying")).toBe(true);
    expect(canTransition("verifying", "verified")).toBe(true);
    expect(canTransition("verified", "planned")).toBe(false);
    expect(canTransition("submitted", "planned")).toBe(false);
  });

  it("ignores invalid transitions and logs them", () => {
    let m = migration();
    const id = m.chains[0]!.actions[0]!.id;
    m = patch(m, id, { status: "verified" });
    m = patch(m, id, { status: "planned" });
    expect(m.chains[0]!.actions[0]!.status).toBe("verified");
    expect(m.log.at(-1)?.message).toMatch(/Ignored invalid transition/);
  });

  it("only resets actions that cannot still land onchain", () => {
    const base = migration().chains[0]!.actions[1]!;
    expect(isSafelyRetryable({ ...base, status: "rejected" })).toBe(true);
    expect(isSafelyRetryable({ ...base, status: "failed", txHash: "0x1", error: { code: "reverted", message: "" } })).toBe(true);
    expect(isSafelyRetryable({ ...base, status: "needs_attention", txHash: "0x1", error: { code: "rpc_error", message: "" } })).toBe(false);
    expect(isSafelyRetryable({ ...base, status: "verified" })).toBe(false);
  });

  it("RETRY_FAILED re-plans retryable actions and keeps verified ones", () => {
    let m = migration();
    const [deploy, erc20] = m.chains[0]!.actions;
    m = patch(m, deploy!.id, { status: "verified", txHash: "0xd" });
    m = patch(m, erc20!.id, { status: "awaiting_wallet" });
    m = patch(m, erc20!.id, { status: "rejected", error: { code: "user_rejected", message: "no" } });
    expect(hasRetryable(m)).toBe(true);
    expect(chainOutcome(m.chains[0]!)).toBe("needs_attention");
    m = migrationReducer(m, { type: "RETRY_FAILED" })!;
    expect(m.chains[0]!.actions[0]!.status).toBe("verified");
    expect(m.chains[0]!.actions[0]!.txHash).toBe("0xd");
    expect(m.chains[0]!.actions[1]!).toMatchObject({ status: "planned", error: null });
  });

  it("reports completion only when every action succeeded", () => {
    let m = migration();
    for (const a of m.chains[0]!.actions) m = patch(m, a.id, { status: "verified" });
    expect(chainOutcome(m.chains[0]!)).toBe("completed");
    expect(migrationProgress(m)).toMatchObject({ complete: true, attention: 0 });
  });
});

describe("persistence", () => {
  it("round-trips a migration", () => {
    const store = memoryStore();
    const m = migration();
    saveMigration(store, m);
    expect(loadMigration(store, SOURCE)).toEqual(m);
  });

  it("marks an interrupted running session as paused for reconciliation", () => {
    const store = memoryStore();
    let m = migrationReducer(migration(), { type: "RUN_STATE", runState: "running" })!;
    const id = m.chains[0]!.actions[1]!.id;
    m = patch(m, id, { status: "submitted", txHash: "0xabc" });
    saveMigration(store, m);
    const loaded = loadMigration(store, SOURCE)!;
    expect(loaded.runState).toBe("paused");
    expect(loaded.chains[0]!.actions[1]!.txHash).toBe("0xabc");
    expect(loaded.log.at(-1)?.message).toMatch(/in flight/);
  });

  it("rejects corrupted or foreign data", () => {
    const store = memoryStore();
    store.setItem(migrationKey(SOURCE), "{not json");
    expect(loadMigration(store, SOURCE)).toBeNull();
    store.setItem(migrationKey(SOURCE), JSON.stringify({ schemaVersion: 2 }));
    expect(loadMigration(store, SOURCE)).toBeNull();
  });

  it("reads testnet demo imports", () => {
    const store = memoryStore();
    store.setItem(testnetAssetsKey(SOURCE), JSON.stringify([{ chainId: SEPOLIA, txHash: "0x1", imports: [{ chainId: SEPOLIA, standard: "erc20", contract: SAFE, tokenId: null }] }]));
    expect(loadTestnetImports(store, SOURCE)).toHaveLength(1);
    store.setItem(testnetAssetsKey(SOURCE), "garbage");
    expect(loadTestnetImports(store, SOURCE)).toEqual([]);
  });

  it("archives replaced migrations newest first, deduplicated and capped", () => {
    const store = memoryStore();
    const m = migration();
    archiveMigration(store, m);
    archiveMigration(store, { ...m, id: "m2" });
    archiveMigration(store, m);
    expect(loadMigrationHistory(store, SOURCE).map((x) => x.id)).toEqual(["m1", "m2"]);
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) archiveMigration(store, { ...m, id: `n${i}` });
    const history = loadMigrationHistory(store, SOURCE);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]!.id).toBe(`n${HISTORY_LIMIT + 2}`);
    store.setItem(historyKey(SOURCE), "garbage");
    expect(loadMigrationHistory(store, SOURCE)).toEqual([]);
  });
});

describe("starting a follow-up migration", () => {
  it("is blocked while any action could still land onchain", () => {
    const m = migration();
    const id = m.chains[0]!.actions[1]!.id;
    expect(hasInFlightActions(m)).toBe(false);
    expect(hasInFlightActions(patch(m, id, { status: "awaiting_wallet" }))).toBe(true);
    expect(hasInFlightActions(patch(m, id, { status: "submitted", txHash: "0x1" }))).toBe(true);
    expect(hasInFlightActions(patch(m, id, { status: "verified" }))).toBe(false);
  });
});
