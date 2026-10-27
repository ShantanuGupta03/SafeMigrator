import { describe, expect, it } from "vitest";
import { executionGate } from "@/lib/chains/registry";
import type { ChainSafeTarget } from "@/lib/domain/types";
import type { FeeQuote } from "@/lib/services/gas-estimation";
import { actionId, assembleChainPlan, buildActions, type ChainPreflight } from "@/lib/services/migration-planning";
import { asset, contracts130, NFT, SAFE, SEPOLIA } from "./fixtures";

const fee: FeeQuote = { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, currentGasPrice: 5n, eip1559: true };
const ETH = 10n ** 18n;

function target(status: ChainSafeTarget["status"] = "not_deployed"): ChainSafeTarget {
  return { chainId: SEPOLIA, safeVersion: "1.3.0", contracts: contracts130(), predictedAddress: SAFE, status, inspection: null, issues: [] };
}

const assets = [
  asset({ standard: "native", balance: ETH.toString() }),
  asset({ standard: "erc721", contract: NFT, tokenId: "7", name: "Art" }),
  asset({ standard: "erc20" }),
];

function preflight(overrides: Partial<ChainPreflight> = {}, actions = buildActions(SEPOLIA, assets, true)): ChainPreflight {
  const estimates: ChainPreflight["estimates"] = {};
  const simulations: ChainPreflight["simulations"] = {};
  for (const a of actions) {
    estimates[a.id] = { gasLimit: a.kind === "deploy_safe" ? 300_000n : 60_000n, l1Fee: 0n, assumed: false };
    simulations[a.id] = { ok: true };
  }
  return {
    chainId: SEPOLIA,
    target: target(),
    nativeBalance: ETH,
    fee,
    estimates,
    simulations,
    capability: undefined,
    gate: executionGate(SEPOLIA),
    pendingTransactions: 0,
    errors: [],
    ...overrides,
  };
}

const opts = { verifiedOwnerCount: 0, threshold: 2, walletChainId: SEPOLIA, dustMultiple: 3 };

describe("action building", () => {
  it("orders deploy → ERC-20 → ERC-721 → native last, with deterministic ids", () => {
    const actions = buildActions(SEPOLIA, assets, true);
    expect(actions.map((a) => a.kind)).toEqual(["deploy_safe", "transfer_erc20", "transfer_erc721", "transfer_native"]);
    expect(actions[2]!.id).toBe(actionId(SEPOLIA, "transfer_erc721", NFT, ["7"]));
    expect(buildActions(SEPOLIA, [...assets].reverse(), true).map((a) => a.id)).toEqual(actions.map((a) => a.id));
  });

  it("skips deployment when a matching Safe exists", () => {
    expect(buildActions(SEPOLIA, assets, false)[0]!.status).toBe("skipped");
  });

  it("groups ERC-1155 ids per contract", () => {
    const actions = buildActions(SEPOLIA, [asset({ standard: "erc1155", tokenId: "2", balance: "5" }), asset({ standard: "erc1155", tokenId: "1", balance: "3" })], false);
    const batch = actions.find((a) => a.kind === "transfer_erc1155")!;
    expect(batch.tokenIds).toEqual(["1", "2"]);
    expect(batch.amounts).toEqual(["3", "5"]);
  });
});

describe("chain plan assembly", () => {
  it("reserves every fee before computing the native amount", () => {
    const plan = assembleChainPlan(preflight(), buildActions(SEPOLIA, assets, true), opts);
    const reserve = (300_000n + 60_000n * 3n) * 10n;
    expect(plan.nativeReserve).toBe(reserve);
    expect(plan.nativeToSend).toBe(ETH - reserve);
    expect(plan.actions.at(-1)!.amounts).toEqual([(ETH - reserve).toString()]);
    expect(plan.executable).toBe(true);
  });

  it("counts wallet confirmations honestly for sequential execution", () => {
    const plan = assembleChainPlan(preflight(), buildActions(SEPOLIA, assets, true), { ...opts, walletChainId: 1 });
    expect(plan.confirmations).toMatchObject({ chainSwitch: 1, deployment: 1, transfers: 3, total: 5 });
  });

  it("counts one batch for deployment + tokens, plus the native transfer, with atomic batching", () => {
    const pre = preflight({ capability: { chainId: SEPOLIA, atomic: "ready", source: "wallet", note: null } });
    const plan = assembleChainPlan(pre, buildActions(SEPOLIA, assets, true), opts);
    expect(plan.strategy).toBe("atomic_batch");
    expect(plan.confirmations).toMatchObject({ deployment: 0, transfers: 2, total: 2, deploymentInBatch: true });
    expect(plan.confirmations.note).toMatch(/upgrade/);
  });

  it("keeps the deployment separate when sequential execution is chosen", () => {
    const pre = preflight({ capability: { chainId: SEPOLIA, atomic: "supported", source: "wallet", note: null } });
    const plan = assembleChainPlan(pre, buildActions(SEPOLIA, assets, true), { ...opts, strategyOverride: "sequential" });
    expect(plan.confirmations).toMatchObject({ deployment: 1, transfers: 3, total: 4, deploymentInBatch: false });
  });

  it("blocks with a clear deficit when gas is insufficient", () => {
    const plan = assembleChainPlan(preflight({ nativeBalance: 1000n }), buildActions(SEPOLIA, assets, true), opts);
    expect(plan.executable).toBe(false);
    expect(plan.deficit).toBeGreaterThan(0n);
    expect(plan.blockers.join(" ")).toMatch(/Insufficient ETH/);
  });

  it("skips dust native balances", () => {
    const actions = buildActions(SEPOLIA, assets, true);
    const reserve = (300_000n + 60_000n * 3n) * 10n;
    const plan = assembleChainPlan(preflight({ nativeBalance: reserve + 100n }), actions, opts);
    expect(plan.actions.at(-1)!.status).toBe("skipped");
    expect(plan.warnings.join(" ")).toMatch(/too small/);
  });

  it("excludes assets whose transfer simulation fails", () => {
    const actions = buildActions(SEPOLIA, assets, true);
    const nftId = actions[2]!.id;
    const pre = preflight();
    pre.simulations[nftId] = { ok: false, reason: "Simulation reverted: soulbound" };
    delete pre.estimates[nftId];
    const plan = assembleChainPlan(pre, actions, opts);
    expect(plan.excluded.map((e) => e.action.id)).toEqual([nftId]);
    expect(plan.actions.some((a) => a.id === nftId)).toBe(false);
  });

  it("blocks incompatible or mismatched Safe targets and pending transactions", () => {
    const actions = buildActions(SEPOLIA, assets, true);
    expect(assembleChainPlan(preflight({ target: { ...target("deployed_mismatch"), issues: ["Owners differ."] } }), actions, opts).executable).toBe(false);
    expect(assembleChainPlan(preflight({ target: { ...target("incompatible"), issues: ["No canonical contracts."] } }), actions, opts).executable).toBe(false);
    expect(assembleChainPlan(preflight({ pendingTransactions: 1 }), actions, opts).blockers.join(" ")).toMatch(/pending/);
  });

  it("blocks a deployment the saved Safe forbids and changed governance until it is accepted", () => {
    const actions = buildActions(SEPOLIA, assets, true);
    const blocked = assembleChainPlan(preflight({ target: { ...target("not_deployed"), deploymentBlocked: "Sepolia: owners changed." } }), actions, opts);
    expect(blocked.blockers.join(" ")).toMatch(/new deployment is not allowed here: Sepolia: owners changed/);
    const existing = buildActions(SEPOLIA, assets, false);
    const changed = preflight({ target: { ...target("deployed_governance_changed"), issues: ["Threshold is 1, expected 2."] } });
    expect(assembleChainPlan(changed, existing, opts).blockers.join(" ")).toMatch(/changed since it was deployed/);
    expect(assembleChainPlan(changed, existing, { ...opts, governanceAccepted: true }).blockers).toEqual([]);
  });

  it("requires verified owners on production networks", () => {
    const pre = preflight({ gate: { enabled: true, reason: null, requiresVerifiedOwners: true } });
    const plan = assembleChainPlan(pre, buildActions(SEPOLIA, assets, true), opts);
    expect(plan.blockers.join(" ")).toMatch(/2 owners verified/);
    expect(assembleChainPlan(pre, buildActions(SEPOLIA, assets, true), { ...opts, verifiedOwnerCount: 2 }).executable).toBe(true);
  });
});
