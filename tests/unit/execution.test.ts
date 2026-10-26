/**
 * Executor orchestration tests. The wallet, RPC client and onchain reads are MOCKED with a tiny
 * in-memory ledger so control flow (resume, retry, rejection, fallback) can be asserted. This is
 * not a substitute for the live testnet run described in docs/TESTNET_GUIDE.md.
 */
import { getAddress, pad, toHex, type Address, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredAsset, ExecutionStrategy, Migration, MigrationAction } from "@/lib/domain/types";
import { buildTransferCall } from "@/lib/services/asset-transfer";
import { runMigration, type ExecutorDeps, type SendTxRequest, type WalletPort } from "@/lib/services/migration-execution";
import { buildActions, createMigration, type ChainPlan } from "@/lib/services/migration-planning";
import { chainOutcome, isSafelyRetryable, migrationReducer, type MigrationEvent } from "@/lib/state/machine";
import { asset, CHIADO, CONFIG, contracts130, SAFE, SEPOLIA, SOURCE } from "./fixtures";

const DEPLOY_DATA = "0xdead" as Hex;

/* ------------------------------ Simulated chain ----------------------------- */

const world = vi.hoisted(() => ({
  deployed: new Set<number>(),
  configMismatch: false,
  /** Address the mocked deployment calldata would create (CREATE2). */
  deployTarget: null as string | null,
  delivered: new Set<string>(),
  balance: 10n ** 18n,
  /** hash -> { chainId, actionId, revert } */
  txs: new Map<string, { chainId: number; actionId: string; revert: boolean; mined: boolean }>(),
}));

vi.mock("@/lib/services/onchain-verification", () => ({
  inspectSafe: vi.fn(async (client: { chainId: number }, address: string) => {
    const has = world.deployed.has(client.chainId);
    return {
      address,
      hasCode: has,
      isSafe: has,
      owners: has ? CONFIG.owners : [],
      threshold: has ? 2 : 0,
      version: has ? "1.3.0" : null,
      singleton: null,
      fallbackHandler: null,
      guard: null,
      modules: [],
      nonce: has ? "0" : null,
      blockNumber: "5",
    };
  }),
  compareSafeToConfig: vi.fn(() => (world.configMismatch ? ["Owners differ from the expected configuration."] : [])),
  readErc20Balance: vi.fn(),
  readErc721Owner: vi.fn(),
  readErc1155Balances: vi.fn(),
}));

vi.mock("@/lib/services/safe-deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/safe-deployment")>()),
  buildDeploymentTransaction: vi.fn(async () => ({ to: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2", value: 0n, data: "0xdead" })),
  deploymentTargetAddress: vi.fn(async () => world.deployTarget ?? SAFE),
}));

vi.mock("@/lib/services/gas-estimation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/gas-estimation")>()),
  getFeeQuote: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, currentGasPrice: 5n, eip1559: true })),
  estimateCallGas: vi.fn(async () => 50_000n),
  estimateL1DataFee: vi.fn(async () => 0n),
}));

vi.mock("@/lib/services/asset-transfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/asset-transfer")>();
  return {
    ...actual,
    refreshTransferAmounts: vi.fn(async (_c: unknown, a: MigrationAction) => ({
      amounts: a.amounts,
      alreadyInSafe: false,
      nothingToMove: world.delivered.has(a.id),
    })),
    simulateTransfer: vi.fn(async () => ({ ok: true })),
    readSafeBalances: vi.fn(async (_c: unknown, a: MigrationAction) => a.amounts.map(() => "0")),
    verifyTransfer: vi.fn(async (_c: unknown, a: MigrationAction) => ({
      status: world.delivered.has(a.id) ? "verified" : "needs_attention",
      verification: { expected: a.amounts[0] ?? "0", safeDelta: world.delivered.has(a.id) ? (a.amounts[0] ?? "0") : "0", sourceRemaining: null, note: null, blockNumber: "5" },
    })),
  };
});

function receiptFor(hash: Hex) {
  const tx = world.txs.get(hash);
  return { status: tx?.revert ? "reverted" : "success", gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: 5n, transactionHash: hash };
}

function land(hash: Hex) {
  const tx = world.txs.get(hash);
  if (!tx) return;
  tx.mined = true;
  if (tx.revert) return;
  if (tx.actionId.endsWith("deploy_safe")) world.deployed.add(tx.chainId);
  else world.delivered.add(tx.actionId);
}

function clientFor(chainId: number): PublicClient {
  return {
    chainId,
    getBalance: vi.fn(async () => world.balance),
    getTransactionCount: vi.fn(async () => 0),
    getBlockNumber: vi.fn(async () => 5n),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      land(hash);
      return receiptFor(hash);
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = world.txs.get(hash);
      if (!tx?.mined) throw new Error("not found");
      return receiptFor(hash);
    }),
    getTransaction: vi.fn(async () => null),
  } as unknown as PublicClient;
}

/* --------------------------------- Harness --------------------------------- */

let counter = 0;
const nextHash = () => pad(toHex(++counter), { size: 32 });

interface WalletScript {
  account?: Address;
  reject?: (actionId: string) => boolean;
  revert?: (actionId: string) => boolean;
  sendCalls?: "ok" | "unsupported" | "reject" | "revert";
}

function harness(initial: Migration, script: WalletScript = {}) {
  let state: Migration = initial;
  let chainId = SEPOLIA;
  const sent: string[] = [];
  const batches: unknown[] = [];

  const resolveAction = (req: { chainId: number; to: string; data: Hex; value: bigint }): string => {
    const c = state.chains.find((x) => x.chainId === req.chainId)!;
    if (req.data === DEPLOY_DATA) return c.actions.find((a) => a.kind === "deploy_safe")!.id;
    const match = c.actions.find((a) => {
      if (a.kind === "deploy_safe") return false;
      const call = buildTransferCall(a, SOURCE, c.safeAddress);
      return call.to.toLowerCase() === req.to.toLowerCase() && call.data === req.data;
    });
    if (!match) throw new Error("Unknown transaction");
    return match.id;
  };

  const wallet: WalletPort = {
    getAccount: () => script.account ?? SOURCE,
    getChainId: async () => chainId,
    switchChain: async (id) => {
      chainId = id;
    },
    sendTransaction: async (req: SendTxRequest) => {
      const actionId = resolveAction(req);
      if (script.reject?.(actionId)) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      const hash = nextHash();
      world.txs.set(hash, { chainId: req.chainId, actionId, revert: script.revert?.(actionId) ?? false, mined: false });
      sent.push(actionId);
      return hash;
    },
    provider: async (cid) => ({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "wallet_sendCalls") {
          if (script.sendCalls === "unsupported") throw Object.assign(new Error("Method not supported"), { code: -32601 });
          if (script.sendCalls === "reject") throw Object.assign(new Error("User rejected"), { code: 4001 });
          const [p] = params as [{ atomicRequired: boolean; calls: { to: string; data: Hex; value: Hex }[] }];
          batches.push(p);
          const hash = nextHash();
          const reverts = script.sendCalls === "revert";
          for (const call of p.calls) {
            const actionId = resolveAction({ chainId: cid, to: call.to, data: call.data, value: BigInt(call.value) });
            if (!reverts) {
              if (actionId.endsWith("deploy_safe")) world.deployed.add(cid);
              else world.delivered.add(actionId);
            }
            sent.push(`batch:${actionId}`);
          }
          world.txs.set(hash, { chainId: cid, actionId: "batch", revert: reverts, mined: true });
          return { id: `batch-${hash}` };
        }
        if (method === "wallet_getCallsStatus") {
          const id = (params as string[])[0]!;
          const reverted = world.txs.get(id.replace("batch-", ""))?.revert;
          return { status: reverted ? 500 : 200, atomic: true, receipts: [{ transactionHash: id.replace("batch-", ""), status: reverted ? "0x0" : "0x1", blockNumber: "0x5" }] };
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  };

  const deps: ExecutorDeps = {
    wallet,
    clientFor,
    dispatch: (e: MigrationEvent) => {
      state = migrationReducer(state, e)!;
    },
    getMigration: () => state,
    shouldStop: () => false,
  };
  return { deps, sent, batches, get state() { return state; }, set state(m: Migration) { state = m; } };
}

const assets: DiscoveredAsset[] = [asset({ standard: "erc20", balance: "1000" }), asset({ standard: "native", balance: (10n ** 18n).toString() })];

function plan(chainId: number, strategy: ExecutionStrategy = "sequential", deployed = false): ChainPlan {
  const chainAssets = assets.map((a) => ({ ...a, chainId, id: a.id.replace(String(SEPOLIA), String(chainId)) }));
  return {
    chainId,
    safeAddress: getAddress(SAFE),
    safeVersion: "1.3.0",
    contracts: contracts130(),
    needsDeployment: !deployed,
    strategy,
    actions: buildActions(chainId, chainAssets, !deployed),
    excluded: [],
    costs: { deployMax: 0n, transfersMax: 0n, totalMax: 0n, totalTypical: 0n },
    nativeBalance: 10n ** 18n,
    nativeReserve: 0n,
    nativeToSend: 0n,
    deficit: 0n,
    confirmations: { chainSwitch: 0, deployment: 1, transfers: 2, total: 3, deploymentInBatch: false, note: null },
    blockers: [],
    warnings: [],
    executable: true,
  };
}

function migrationFor(plans: ChainPlan[]): Migration {
  return createMigration({ id: "m", source: SOURCE, environment: "testnet", safeConfig: CONFIG, verifiedOwners: [], plans });
}

const statuses = (m: Migration, chainId = SEPOLIA) => Object.fromEntries(m.chains.find((c) => c.chainId === chainId)!.actions.map((a) => [a.kind, a.status]));

beforeEach(() => {
  world.deployed.clear();
  world.delivered.clear();
  world.txs.clear();
  world.configMismatch = false;
  world.deployTarget = null;
  world.balance = 10n ** 18n;
});

/* ---------------------------------- Tests ---------------------------------- */

describe("sequential execution", () => {
  it("deploys, verifies, then transfers ERC-20 before native", async () => {
    const h = harness(migrationFor([plan(SEPOLIA)]));
    await runMigration(h.deps);
    expect(h.sent.map((id) => id.split(":")[1])).toEqual(["deploy_safe", "transfer_erc20", "transfer_native"]);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
    expect(h.state.runState).toBe("finished");
    expect(h.state.chains[0]!.phase).toBe("completed");
  });

  it("reserves gas when computing the final native transfer", async () => {
    const h = harness(migrationFor([plan(SEPOLIA)]));
    await runMigration(h.deps);
    const native = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_native")!;
    expect(BigInt(native.amounts[0]!)).toBe(10n ** 18n - 50_000n * 10n);
  });

  it("skips deployment when the expected Safe already exists", async () => {
    world.deployed.add(SEPOLIA);
    const h = harness(migrationFor([plan(SEPOLIA)]));
    await runMigration(h.deps);
    expect(h.sent.some((id) => id.endsWith("deploy_safe"))).toBe(false);
    expect(h.state.chains[0]!.actions[0]!.verification?.note).toMatch(/already deployed/);
    expect(chainOutcome(h.state.chains[0]!)).toBe("completed");
  });

  it("blocks transfers when existing code does not match the configuration", async () => {
    world.deployed.add(SEPOLIA);
    world.configMismatch = true;
    const h = harness(migrationFor([plan(SEPOLIA)]));
    await runMigration(h.deps);
    expect(h.sent).toEqual([]);
    expect(h.state.chains[0]!.phase).toBe("failed");
    expect(h.state.runState).toBe("paused");
  });

  it("does not deploy without enough gas", async () => {
    world.balance = 1000n;
    const h = harness(migrationFor([plan(SEPOLIA)]));
    await runMigration(h.deps);
    expect(h.sent).toEqual([]);
    expect(h.state.chains[0]!.message).toMatch(/Insufficient ETH/);
  });

  it("refuses to run from a different account", async () => {
    const h = harness(migrationFor([plan(SEPOLIA)]), { account: getAddress("0x00000000000000000000000000000000000000ff") });
    await runMigration(h.deps);
    expect(h.sent).toEqual([]);
    expect(h.state.chains[0]!.phase).toBe("needs_attention");
  });
});

describe("rejection, failure and retry", () => {
  it("stops on rejection without touching other chains, and retries without redeploying", async () => {
    let rejectErc20 = true;
    const h = harness(migrationFor([plan(SEPOLIA), plan(CHIADO)]), { reject: (id) => rejectErc20 && id.endsWith(`transfer_erc20:${assets[0]!.contract!.toLowerCase()}`) && id.startsWith(String(SEPOLIA)) });
    await runMigration(h.deps);
    expect(statuses(h.state)).toMatchObject({ deploy_safe: "verified", transfer_erc20: "rejected", transfer_native: "planned" });
    expect(chainOutcome(h.state.chains[1]!)).toBe("not_started");
    expect(h.state.runState).toBe("paused");

    rejectErc20 = false;
    h.state = migrationReducer(h.state, { type: "RETRY_FAILED" })!;
    const before = h.sent.length;
    await runMigration(h.deps);
    const resent = h.sent.slice(before);
    expect(resent.filter((id) => id.endsWith("deploy_safe") && id.startsWith(String(SEPOLIA)))).toEqual([]);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
    expect(statuses(h.state, CHIADO)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
    expect(h.state.runState).toBe("finished");
  });

  it("marks a reverted transfer failed, continues with the rest, and allows a safe retry", async () => {
    const h = harness(migrationFor([plan(SEPOLIA)]), { revert: (id) => id.includes("transfer_erc20") });
    await runMigration(h.deps);
    const erc20 = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_erc20")!;
    expect(erc20.status).toBe("failed");
    expect(erc20.error?.code).toBe("reverted");
    expect(isSafelyRetryable(erc20)).toBe(true);
    expect(statuses(h.state).transfer_native).toBe("verified");
    expect(h.state.chains[0]!.phase).toBe("needs_attention");
  });
});

describe("resume after interruption", () => {
  it("reconciles a mined transaction instead of sending it again", async () => {
    world.deployed.add(SEPOLIA);
    const h = harness(migrationFor([plan(SEPOLIA, "sequential", true)]));
    const erc20 = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_erc20")!;
    const hash = nextHash();
    world.txs.set(hash, { chainId: SEPOLIA, actionId: erc20.id, revert: false, mined: false });
    land(hash);
    h.deps.dispatch({ type: "ACTION_PATCH", chainId: SEPOLIA, actionId: erc20.id, patch: { status: "awaiting_wallet" } });
    h.deps.dispatch({ type: "ACTION_PATCH", chainId: SEPOLIA, actionId: erc20.id, patch: { status: "submitted", txHash: hash } });

    await runMigration(h.deps);
    expect(h.sent.filter((id) => id === erc20.id)).toEqual([]);
    expect(statuses(h.state)).toMatchObject({ transfer_erc20: "verified", transfer_native: "verified" });
  });

  it("resolves a dropped transaction from onchain end state", async () => {
    world.deployed.add(SEPOLIA);
    const h = harness(migrationFor([plan(SEPOLIA, "sequential", true)]));
    const erc20 = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_erc20")!;
    h.deps.dispatch({ type: "ACTION_PATCH", chainId: SEPOLIA, actionId: erc20.id, patch: { status: "submitted", txHash: nextHash() } });

    await runMigration(h.deps);
    const after = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_erc20")!;
    expect(after.status).toBe("needs_attention");
    expect(after.error?.code).toBe("dropped");
    expect(isSafelyRetryable(after)).toBe(true);
    expect(h.sent.filter((id) => id === erc20.id)).toEqual([]);
  });

  it("returns an abandoned wallet prompt to planned and sends it once", async () => {
    world.deployed.add(SEPOLIA);
    const h = harness(migrationFor([plan(SEPOLIA, "sequential", true)]));
    const erc20 = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_erc20")!;
    h.deps.dispatch({ type: "ACTION_PATCH", chainId: SEPOLIA, actionId: erc20.id, patch: { status: "awaiting_wallet" } });
    await runMigration(h.deps);
    expect(h.sent.filter((id) => id === erc20.id)).toHaveLength(1);
    expect(statuses(h.state).transfer_erc20).toBe("verified");
  });
});

describe("atomic batching (mocked EIP-5792 wallet)", () => {
  it("deploys the Safe and moves tokens in ONE atomicRequired batch, then sends native last", async () => {
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "ok" });
    await runMigration(h.deps);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toMatchObject({ atomicRequired: true, chainId: toHex(SEPOLIA) });
    const calls = (h.batches[0] as { calls: { data: Hex; value: Hex }[] }).calls;
    expect(calls.map((c) => c.data)).toEqual([DEPLOY_DATA, expect.any(String)]);
    expect(calls.every((c) => BigInt(c.value) === 0n)).toBe(true);
    expect(h.sent.filter((id) => !id.startsWith("batch:")).map((id) => id.split(":")[1])).toEqual(["transfer_native"]);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
    expect(h.state.chains[0]!.batches[0]!.statusCode).toBe(200);
  });

  it("sizes the native remainder from the balance after the batch", async () => {
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "ok" });
    await runMigration(h.deps);
    const native = h.state.chains[0]!.actions.find((a) => a.kind === "transfer_native")!;
    expect(BigInt(native.amounts[0]!)).toBe(10n ** 18n - 50_000n * 10n);
  });

  it("only batches transfers when the Safe already exists", async () => {
    world.deployed.add(SEPOLIA);
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "ok" });
    await runMigration(h.deps);
    expect((h.batches[0] as { calls: { data: Hex }[] }).calls.map((c) => c.data)).not.toContain(DEPLOY_DATA);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
  });

  it("refuses to batch when the deployment would create a different address", async () => {
    world.deployTarget = getAddress("0x00000000000000000000000000000000000000aa");
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "ok" });
    await runMigration(h.deps);
    expect(h.batches).toHaveLength(0);
    expect(h.sent).toEqual([]);
    expect(statuses(h.state).deploy_safe).toBe("failed");
    expect(h.state.chains[0]!.phase).toBe("failed");
  });

  it("sends nothing else when the batch reverts, and retries safely", async () => {
    const script: WalletScript = { sendCalls: "revert" };
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), script);
    await runMigration(h.deps);
    // Native never goes to an address whose Safe deployment did not land.
    expect(statuses(h.state)).toEqual({ deploy_safe: "failed", transfer_erc20: "failed", transfer_native: "planned" });
    expect(h.sent.filter((id) => !id.startsWith("batch:"))).toEqual([]);
    expect(world.deployed.size + world.delivered.size).toBe(0);

    script.sendCalls = "ok";
    h.state = migrationReducer(h.state, { type: "RETRY_FAILED" })!;
    await runMigration(h.deps);
    expect(h.batches).toHaveLength(2);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
  });

  it("falls back to deploy-then-transfer transactions when the wallet cannot batch", async () => {
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "unsupported" });
    await runMigration(h.deps);
    expect(h.batches).toHaveLength(0);
    expect(h.state.chains[0]!.strategy).toBe("sequential");
    expect(h.sent.map((id) => id.split(":")[1])).toEqual(["deploy_safe", "transfer_erc20", "transfer_native"]);
    expect(statuses(h.state)).toEqual({ deploy_safe: "verified", transfer_erc20: "verified", transfer_native: "verified" });
  });

  it("records a rejected batch as rejected, not as sent", async () => {
    const h = harness(migrationFor([plan(SEPOLIA, "atomic_batch")]), { sendCalls: "reject" });
    await runMigration(h.deps);
    expect(statuses(h.state)).toEqual({ deploy_safe: "rejected", transfer_erc20: "rejected", transfer_native: "planned" });
    expect(world.deployed.size + world.delivered.size).toBe(0);
  });
});

describe("network gating", () => {
  it("never executes on a production network that is not enabled", async () => {
    const h = harness(migrationFor([plan(1)]));
    await runMigration(h.deps);
    expect(h.sent).toEqual([]);
    expect(h.state.chains[0]!.phase).toBe("needs_attention");
  });
});
