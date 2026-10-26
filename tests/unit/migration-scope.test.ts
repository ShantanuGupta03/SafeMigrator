import { describe, expect, it } from "vitest";
import { buildMigrationScope, requiresPartialAck } from "@/lib/services/migration-scope";
import type { ChainPlan } from "@/lib/services/migration-planning";
import { asset, CHIADO, CONFIG, contracts130, SAFE, SEPOLIA, SOURCE } from "./fixtures";

function blockedPlan(chainId: number): ChainPlan {
  return {
    chainId,
    safeAddress: SAFE,
    safeVersion: "1.3.0",
    contracts: contracts130(),
    needsDeployment: true,
    strategy: "sequential",
    actions: [],
    excluded: [],
    costs: { deployMax: 0n, transfersMax: 0n, totalMax: 0n, totalTypical: 0n },
    nativeBalance: 0n,
    nativeReserve: 0n,
    nativeToSend: 0n,
    deficit: 1n,
    confirmations: { chainSwitch: 0, deployment: 0, transfers: 0, total: 0, deploymentInBatch: false, note: null },
    blockers: ["Insufficient gas"],
    warnings: [],
    executable: false,
  };
}

describe("buildMigrationScope", () => {
  it("records blocked networks from non-executable plans", () => {
    const a = asset({ chainId: SEPOLIA, standard: "erc20" });
    const scope = buildMigrationScope({
      selection: { chainIds: [SEPOLIA, CHIADO], assets: [a], assetIds: [a.id], dropped: [] },
      selectedChainIds: [SEPOLIA, CHIADO],
      plans: [blockedPlan(CHIADO)],
      discovery: {},
      partialAcknowledged: true,
      plannedAt: Date.now(),
    });
    expect(scope.blockedChains.some((b) => b.chainId === CHIADO)).toBe(true);
    expect(requiresPartialAck(scope)).toBe(true);
    expect(scope.selectedAssets[0]!.assetId).toBe(a.id);
    void SOURCE;
    void CONFIG;
  });
});
