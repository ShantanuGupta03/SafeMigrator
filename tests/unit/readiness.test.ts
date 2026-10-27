import { describe, expect, it } from "vitest";
import type { SafeProfile } from "@/lib/domain/profile";
import { assessReadiness } from "@/lib/services/readiness";
import { buildRecipe, createProfile } from "@/lib/services/safe-profile";
import { CHIADO, CONFIG, contracts130, OWNER_B, OWNER_C, SEPOLIA, SOURCE } from "./fixtures";

const NOW = 1_800_000_000_000;
function profile(): SafeProfile {
  const p = createProfile({ source: SOURCE, environment: "testnet", config: CONFIG, recipe: buildRecipe(CONFIG, "1.3.0", "0x6080"), status: "active", now: NOW });
  const c = contracts130();
  const snap = (chainId: number, owners = CONFIG.owners, threshold = 2) => ({
    chainId,
    address: p.safeAddress!,
    blockNumber: "10",
    blockHash: null,
    observedAt: NOW - 1000,
    isSafe: true,
    owners,
    threshold,
    version: "1.3.0",
    singleton: c.singleton,
    fallbackHandler: c.fallbackHandler,
    guard: null,
    modules: [],
    nonce: "0",
    matchesOriginal: threshold === 2 && owners.length === 3,
    issues: threshold === 2 ? [] : ["Threshold is 1, expected 2."],
  });
  return {
    ...p,
    deployments: [SEPOLIA, CHIADO].map((chainId) => ({ chainId, address: p.safeAddress!, txHash: null, how: "deployed" as const, runId: null, recordedAt: NOW })),
    snapshots: [snap(SEPOLIA), snap(CHIADO, CONFIG.owners, 1)],
  };
}

describe("readiness", () => {
  it("reports observed, attention and missing states factually", () => {
    const items = assessReadiness({ profile: profile(), verifiedOwners: [SOURCE, OWNER_B], safeNativeBalances: { [SEPOLIA]: 10n, [CHIADO]: 0n }, now: NOW });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.deployment!.state).toBe("attention");
    expect(byKey.deployment!.detail.join(" ")).toMatch(/changed since deployment/);
    expect(byKey.owners!.state).toBe("observed");
    expect(byKey.owners!.detail.join(" ")).toMatch(/does not show that owners are different people, devices or seed phrases/);
    expect(byKey.gas!.state).toBe("attention");
    expect(byKey.outgoing!.state).toBe("missing");
  });

  it("measures owners against each network's current threshold and keeps acknowledgement separate from evidence", () => {
    const p = { ...profile(), readiness: { outgoing: [], acknowledgedTestTransaction: NOW } };
    const items = assessReadiness({ profile: p, verifiedOwners: [OWNER_C], safeNativeBalances: { [SEPOLIA]: null }, now: NOW });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.owners!.state).toBe("attention");
    expect(byKey.gas!.state).toBe("unknown");
    expect(byKey.outgoing!.state).toBe("acknowledged");
    expect(byKey.outgoing!.detail.join(" ")).toMatch(/did not observe it/);
  });
});
