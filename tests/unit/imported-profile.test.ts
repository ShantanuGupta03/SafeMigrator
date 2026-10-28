import { describe, expect, it } from "vitest";
import { SOURCE, OWNER_B, OWNER_C } from "./fixtures";
import { buildSafeConfig } from "@/lib/services/signer-configuration";
import {
  chooseImportedProfileForRun,
  createImportedExistingProfile,
  exportProfile,
  importProfile,
  isImportedExistingProfile,
  isPinned,
  parseProfile,
} from "@/lib/services/safe-profile";
import { profileAllowsNetworkDeploy } from "@/lib/domain/destination";

const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const CONFIG = buildSafeConfig([OWNER_C, SOURCE, OWNER_B], 2, "0");

describe("imported existing Safe profiles", () => {
  it("creates a profile without recipe or commitment", () => {
    const p = createImportedExistingProfile({ source: SOURCE, environment: "testnet", safeAddress: SAFE, config: CONFIG });
    expect(isImportedExistingProfile(p)).toBe(true);
    expect(isPinned(p)).toBe(false);
    expect(p.recipe).toBeNull();
    expect(profileAllowsNetworkDeploy(p.destinationKind)).toBe(false);
  });

  it("round-trips export/import", () => {
    const p = createImportedExistingProfile({ source: SOURCE, environment: "testnet", safeAddress: SAFE, config: CONFIG });
    const imported = importProfile(exportProfile(p), { source: SOURCE, environment: "testnet" });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(isImportedExistingProfile(imported.profile)).toBe(true);
  });

  it("rejects imported profile with a recipe", () => {
    const p = createImportedExistingProfile({ source: SOURCE, environment: "testnet", safeAddress: SAFE, config: CONFIG });
    const bad = { ...p, recipe: { derivation: "x" } };
    expect(parseProfile(bad, { source: SOURCE, environment: "testnet" }).ok).toBe(false);
  });

  it("reuses profile for same address", () => {
    const existing = createImportedExistingProfile({ source: SOURCE, environment: "testnet", safeAddress: SAFE, config: CONFIG });
    const { profile } = chooseImportedProfileForRun({ profiles: [existing], source: SOURCE, environment: "testnet", safeAddress: SAFE, config: CONFIG });
    expect(profile.id).toBe(existing.id);
  });
});
