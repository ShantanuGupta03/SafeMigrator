import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type PublicClient } from "viem";
import type { SafeInspection } from "@/lib/domain/types";
import { resolveExistingSafeTarget } from "@/lib/services/existing-destination";
import { inspectSafe } from "@/lib/services/onchain-verification";
import { CONFIG, SAFE, SEPOLIA, SOURCE, contracts130 } from "./fixtures";

vi.mock("@/lib/services/onchain-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/onchain-verification")>();
  return { ...actual, inspectSafe: vi.fn() };
});

function inspection(patch: Partial<SafeInspection> = {}): SafeInspection {
  const contracts = contracts130();
  return {
    address: SAFE, hasCode: true, isSafe: true, owners: CONFIG.owners,
    threshold: 2, version: "1.3.0", singleton: contracts.singleton,
    fallbackHandler: contracts.fallbackHandler, guard: zeroAddress,
    modules: [], nonce: "0", blockNumber: "123", blockHash: null,
    ...patch,
  };
}

async function assess(state: SafeInspection, threshold = 2) {
  vi.mocked(inspectSafe).mockResolvedValue(state);
  return resolveExistingSafeTarget({
    chainId: SEPOLIA, address: SAFE, environment: "testnet",
    client: {} as PublicClient, referenceConfig: { ...CONFIG, threshold },
  });
}

describe("existing Safe security policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, zeroAddress])("does not treat an empty guard %s as installed", async (guard) => {
    const result = await assess(inspection({ guard }));
    expect(result.target.status).toBe("deployed_matching");
    expect(result.securityNotes).toEqual([]);
  });

  it.each([1, 2, 3])("keeps a real guard blocked with reference threshold %i", async (threshold) => {
    const result = await assess(inspection({ guard: SOURCE }), threshold);
    expect(result.target.status).toBe("incompatible");
    expect(result.securityNotes.join(" ")).toContain("transaction guard");
  });

  it.each([1, 2, 3])("keeps modules blocked with reference threshold %i", async (threshold) => {
    const result = await assess(inspection({ modules: [SOURCE] }), threshold);
    expect(result.target.status).toBe("incompatible");
    expect(result.securityNotes.join(" ")).toContain("modules");
  });

  it("still reports owner/threshold drift for an otherwise supported Safe", async () => {
    const result = await assess(inspection(), 1);
    expect(result.target.status).toBe("deployed_governance_changed");
    expect(result.securityNotes).toEqual([]);
    expect(result.target.issues.join(" ")).toContain("Threshold is 2");
  });
});
