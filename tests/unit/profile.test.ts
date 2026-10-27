/**
 * Saved Safe profiles: recipe pinning, tamper detection, persistence migration and import.
 * Chain reads are MOCKED (canonical-code verification, Protocol Kit prediction, Safe inspection);
 * the CREATE2 math, commitments and schema checks are real.
 */
import { getAddress, keccak256, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeProfile } from "@/lib/domain/profile";
import type { Migration, SafeInspection } from "@/lib/domain/types";
import { decideNegotiation, type VersionCheck } from "@/lib/services/safe-deployment";
import {
  buildRecipe,
  createProfile,
  exportProfile,
  governanceByChain,
  importProfile,
  legacyProfilesFromMigrations,
  parseProfile,
  recipeAddress,
  recipeCommitment,
  recoverLegacyProfile,
  resolvePinnedTarget,
  syncProfileWithMigration,
  validateRecipe,
} from "@/lib/services/safe-profile";
import { buildSafeConfig } from "@/lib/services/signer-configuration";
import { loadProfiles, profilesKey, saveProfiles, withLegacyProfiles } from "@/lib/state/profile-store";
import { memoryStore } from "@/lib/state/persistence";
import { CHIADO, CONFIG, contracts130, OWNER_B, OWNER_C, SEPOLIA, SOURCE } from "./fixtures";

/** Placeholder creation code: the math is real, the bytes are not the factory's. */
const CODE = "0x608060405234801561001057600080fd5b50" as Hex;
const BASE_SEPOLIA = 84532;

const chain = vi.hoisted(() => ({
  unreachable: new Set<number>(),
  incompatible: new Set<number>(),
  creationCode: new Map<number, string>(),
  inspection: new Map<number, Partial<SafeInspection>>(),
  sdkAddress: null as string | null,
}));

vi.mock("@/lib/services/safe-deployment", async (orig) => {
  const actual = await orig<typeof import("@/lib/services/safe-deployment")>();
  return {
    ...actual,
    verifyCanonicalContracts: vi.fn(async (client: { chainId: number }, version: "1.3.0" | "1.4.1") => {
      if (chain.unreachable.has(client.chainId)) throw new Error("fetch failed");
      const ok = !chain.incompatible.has(client.chainId);
      return { version, ok, contracts: actual.canonicalContractSet(version), issues: ok ? [] : [`v${version} singleton is not deployed`] };
    }),
    predictSafe: vi.fn(async () => ({ sdkAddress: chain.sdkAddress, independentAddress: chain.sdkAddress, issues: [] })),
  };
});

vi.mock("@/lib/services/onchain-verification", async (orig) => ({
  ...(await orig<typeof import("@/lib/services/onchain-verification")>()),
  inspectSafe: vi.fn(async (client: { chainId: number }, address: string) => ({
    address,
    hasCode: false,
    isSafe: false,
    owners: [],
    threshold: 0,
    version: null,
    singleton: null,
    fallbackHandler: null,
    guard: null,
    modules: [],
    nonce: null,
    blockNumber: "100",
    blockHash: null,
    ...chain.inspection.get(client.chainId),
  })),
}));

function client(chainId: number): PublicClient {
  return {
    chainId,
    getChainId: async () => {
      if (chain.unreachable.has(chainId)) throw new Error("fetch failed");
      return chainId;
    },
    readContract: async () => (chain.creationCode.get(chainId) ?? CODE) as Hex,
  } as unknown as PublicClient;
}

function profile(overrides: Partial<SafeProfile> = {}): SafeProfile {
  return { ...createProfile({ id: "11111111-2222-3333-4444-555555555555", source: SOURCE, environment: "testnet", config: CONFIG, recipe: buildRecipe(CONFIG, "1.3.0", CODE), status: "active", now: 1_700_000_000_000 }), ...overrides };
}

function deployedSafe(owners = CONFIG.owners, threshold = CONFIG.threshold): Partial<SafeInspection> {
  const c = contracts130();
  return { hasCode: true, isSafe: true, owners, threshold, version: "1.3.0", singleton: c.singleton, fallbackHandler: c.fallbackHandler, guard: null, modules: [], nonce: "0" };
}

beforeEach(() => {
  chain.unreachable.clear();
  chain.incompatible.clear();
  chain.creationCode.clear();
  chain.inspection.clear();
  chain.sdkAddress = recipeAddress(buildRecipe(CONFIG, "1.3.0", CODE));
});

describe("deployment recipe", () => {
  it("binds owners, threshold, salt, version and creation code into the commitment and address", () => {
    const r = buildRecipe(CONFIG, "1.3.0", CODE);
    expect(validateRecipe(r, CONFIG)).toEqual([]);
    const variants = [
      buildRecipe(buildSafeConfig(CONFIG.owners, 3, CONFIG.saltNonce), "1.3.0", CODE),
      buildRecipe(buildSafeConfig(CONFIG.owners, 2, "7"), "1.3.0", CODE),
      buildRecipe(CONFIG, "1.4.1", CODE),
      buildRecipe(CONFIG, "1.3.0", `${CODE}00` as Hex),
    ];
    for (const v of variants) {
      expect(recipeCommitment(v)).not.toBe(recipeCommitment(r));
      expect(recipeAddress(v)).not.toBe(recipeAddress(r));
    }
    expect(recipeCommitment(buildRecipe(CONFIG, "1.3.0", CODE))).toBe(recipeCommitment(r));
  });

  it("rejects non-canonical contracts, a modified initializer or a broken code hash", () => {
    const r = buildRecipe(CONFIG, "1.3.0", CODE);
    expect(validateRecipe({ ...r, singleton: OWNER_B }, CONFIG).join()).toMatch(/singleton/);
    expect(validateRecipe({ ...r, factory: OWNER_B }, CONFIG).join()).toMatch(/Factory/);
    expect(validateRecipe({ ...r, initializer: `${r.initializer}00` as Hex }, CONFIG).join()).toMatch(/Initializer/);
    expect(validateRecipe({ ...r, proxyCreationCodeHash: keccak256("0x01") }, CONFIG).join()).toMatch(/hash/);
    expect(validateRecipe(r, { ...CONFIG, threshold: 3 }).join()).toMatch(/Initializer/);
  });
});

describe("profile validation", () => {
  it("accepts a consistent profile and rejects tampering", () => {
    const p = profile();
    expect(parseProfile(JSON.parse(JSON.stringify(p))).ok).toBe(true);
    expect(parseProfile({ ...p, safeAddress: OWNER_C })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, commitment: keccak256("0x02") })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, original: { ...p.original, threshold: 1 } })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, original: { ...p.original, owners: [...p.original.owners].reverse() } })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, recipe: { ...p.recipe!, safeVersion: "1.4.1" } })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, deployments: [{ chainId: SEPOLIA, address: OWNER_B, txHash: null, how: "existing", runId: null, recordedAt: 1 }] })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, deployments: [{ chainId: 1, address: p.safeAddress, txHash: null, how: "existing", runId: null, recordedAt: 1 }] })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, status: "needs_recovery" })).toMatchObject({ ok: false });
    expect(parseProfile({ ...p, source: OWNER_B }, { source: SOURCE })).toMatchObject({ ok: false });
    expect(parseProfile("nonsense")).toMatchObject({ ok: false });
  });
});

describe("pinned target resolution", () => {
  it("reuses the pinned recipe and never renegotiates a version", async () => {
    const p = profile();
    const t = await resolvePinnedTarget(BASE_SEPOLIA, client(BASE_SEPOLIA), p);
    expect(t).toMatchObject({ status: "not_deployed", predictedAddress: p.safeAddress, safeVersion: "1.3.0", pinned: true });
  });

  it("blocks a network that cannot reproduce the recipe instead of choosing another version", async () => {
    chain.incompatible.add(BASE_SEPOLIA);
    const t = await resolvePinnedTarget(BASE_SEPOLIA, client(BASE_SEPOLIA), profile());
    expect(t.status).toBe("incompatible");
    expect(t.predictedAddress).toBeNull();
    expect(t.safeVersion).toBe("1.3.0");
    expect(t.issues.join(" ")).toMatch(/will not switch versions/);
  });

  it("reports an unreachable RPC as unknown, not as incompatible or not deployed", async () => {
    chain.unreachable.add(CHIADO);
    const t = await resolvePinnedTarget(CHIADO, client(CHIADO), profile());
    expect(t.unavailable).toBe(true);
    expect(t.status).toBe("error");
    expect(t.predictedAddress).toBeNull();
  });

  it("blocks when the factory's creation code differs from the recipe", async () => {
    chain.creationCode.set(SEPOLIA, `${CODE}ff`);
    expect((await resolvePinnedTarget(SEPOLIA, client(SEPOLIA), profile())).status).toBe("incompatible");
  });

  it("detects a recipe/address mismatch in an in-memory profile", async () => {
    const t = await resolvePinnedTarget(SEPOLIA, client(SEPOLIA), profile({ safeAddress: OWNER_B }));
    expect(t.status).toBe("error");
    expect(t.issues.join(" ")).toMatch(/tampered/);
  });

  it("classifies a matching Safe, changed governance and a foreign contract", async () => {
    chain.inspection.set(SEPOLIA, deployedSafe());
    expect((await resolvePinnedTarget(SEPOLIA, client(SEPOLIA), profile())).status).toBe("deployed_matching");
    chain.inspection.set(SEPOLIA, deployedSafe([SOURCE, OWNER_B], 2));
    const changed = await resolvePinnedTarget(SEPOLIA, client(SEPOLIA), profile());
    expect(changed.status).toBe("deployed_governance_changed");
    expect(changed.issues.join(" ")).toMatch(/Owners differ/);
    chain.inspection.set(SEPOLIA, { hasCode: true, isSafe: false });
    expect((await resolvePinnedTarget(SEPOLIA, client(SEPOLIA), profile())).status).toBe("deployed_mismatch");
  });
});

describe("version negotiation for new configurations", () => {
  const check = (version: "1.3.0" | "1.4.1", ok: boolean): VersionCheck => ({ version, ok, contracts: contracts130(), issues: ok ? [] : ["missing"] });

  it("chooses the newest version available everywhere", () => {
    const checks = new Map([
      [SEPOLIA, [check("1.4.1", true), check("1.3.0", true)]],
      [CHIADO, [check("1.4.1", false), check("1.3.0", true)]],
    ]);
    expect(decideNegotiation([SEPOLIA, CHIADO], checks, new Map()).commonVersion).toBe("1.3.0");
  });

  it("does not pick a version from a subset when a network is unreachable", () => {
    const checks = new Map([[SEPOLIA, [check("1.4.1", true), check("1.3.0", true)]]]);
    const r = decideNegotiation([SEPOLIA, CHIADO], checks, new Map([[CHIADO, "Could not verify: fetch failed"]]));
    expect(r.commonVersion).toBeNull();
    expect(r.unavailable).toEqual([CHIADO]);
    expect(r.perChain[SEPOLIA]!.version).toBeNull();
  });
});

describe("profile persistence", () => {
  it("round-trips through storage and preserves identity", () => {
    const store = memoryStore();
    const p = profile();
    saveProfiles(store, SOURCE, [p]);
    const { profiles, rejected } = loadProfiles(store, SOURCE);
    expect(rejected).toEqual([]);
    expect(profiles[0]).toMatchObject({ id: p.id, commitment: p.commitment, safeAddress: p.safeAddress });
  });

  it("rejects a corrupted entry without losing the others, and keeps it in storage", () => {
    const store = memoryStore();
    const good = profile();
    const bad = { ...profile({ id: "99999999-2222-3333-4444-555555555555" }), safeAddress: OWNER_B };
    store.setItem(profilesKey(SOURCE), JSON.stringify({ kind: "safe-migrator/profile-store", schemaVersion: 1, profiles: [good, bad] }));
    const loaded = loadProfiles(store, SOURCE);
    expect(loaded.profiles.map((p) => p.id)).toEqual([good.id]);
    expect(loaded.rejected).toHaveLength(1);
    saveProfiles(store, SOURCE, loaded.profiles);
    expect(JSON.parse(store.getItem(profilesKey(SOURCE))!).profiles).toHaveLength(2);
  });

  it("treats unreadable stores as empty with a reported reason", () => {
    const store = memoryStore();
    store.setItem(profilesKey(SOURCE), "{not json");
    expect(loadProfiles(store, SOURCE)).toMatchObject({ profiles: [], rejected: [{ id: null }] });
  });
});

describe("profile export and import", () => {
  it("preserves identity and drops observations that came from the file", () => {
    const p = syncProfileWithMigration(profile(), migrationWithDeployment(profile()));
    expect(p.snapshots).toHaveLength(1);
    const r = importProfile(exportProfile(p), { source: SOURCE, environment: "testnet" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).toMatchObject({ id: p.id, commitment: p.commitment, safeAddress: p.safeAddress, deployments: p.deployments });
    expect(r.profile.snapshots).toEqual([]);
  });

  it("rejects altered, foreign, oversized or malformed files", () => {
    const text = exportProfile(profile());
    expect(importProfile(text.replace(profile().safeAddress!, OWNER_B), { source: SOURCE, environment: "testnet" }).ok).toBe(false);
    expect(importProfile(text, { source: OWNER_B, environment: "testnet" }).ok).toBe(false);
    expect(importProfile(text, { source: SOURCE, environment: "mainnet" }).ok).toBe(false);
    expect(importProfile("x".repeat(600 * 1024), { source: SOURCE, environment: "testnet" }).ok).toBe(false);
    expect(importProfile('{"kind":"other"}', { source: SOURCE, environment: "testnet" }).ok).toBe(false);
  });
});

function migrationWithDeployment(p: SafeProfile, chainId = SEPOLIA, version: "1.3.0" | "1.4.1" = "1.3.0", address: `0x${string}` = p.safeAddress ?? OWNER_C): Migration {
  return {
    id: `run-${chainId}`,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    source: SOURCE,
    environment: "testnet",
    safeConfig: CONFIG,
    verifiedOwners: [],
    chains: [
      {
        chainId,
        safeAddress: getAddress(address),
        safeVersion: version,
        contracts: contracts130(),
        strategy: "sequential",
        phase: "completed",
        message: null,
        batches: [],
        safeVerification: { address: getAddress(address), blockNumber: "200", blockHash: null, ...deployedSafe() } as SafeInspection,
        actions: [
          {
            id: `${chainId}:deploy_safe`,
            chainId,
            kind: "deploy_safe",
            label: "Deploy",
            assetIds: [],
            contract: null,
            tokenIds: [],
            amounts: [],
            decimals: 0,
            symbol: "",
            status: "verified",
            txHash: `0x${"ab".repeat(32)}`,
            callsId: null,
            txNonce: 0,
            submittedAt: 1,
            safeBalancesBefore: null,
            gasLimit: null,
            feeEstimate: null,
            feePaid: null,
            verification: null,
            error: null,
            attempts: 1,
          },
        ],
      },
    ],
    runState: "finished",
    log: [],
    profileId: p.id,
  };
}

describe("linking runs", () => {
  it("records deployments and snapshots from a run of this profile only", () => {
    const p = profile({ status: "proposed" });
    const synced = syncProfileWithMigration(p, migrationWithDeployment(p));
    expect(synced.status).toBe("active");
    expect(synced.runIds).toEqual([`run-${SEPOLIA}`]);
    expect(synced.deployments[0]).toMatchObject({ chainId: SEPOLIA, how: "deployed" });
    expect(governanceByChain(synced, Date.now())[0]).toMatchObject({ state: "matches_original" });
    expect(syncProfileWithMigration(p, { ...migrationWithDeployment(p), profileId: "other" })).toBe(p);
  });
});

describe("legacy records", () => {
  const legacyRun = (chainId: number, version: "1.3.0" | "1.4.1" = "1.3.0", address?: `0x${string}`) => {
    const m = migrationWithDeployment(profile(), chainId, version, address);
    return { ...m, id: `legacy-${chainId}-${version}`, profileId: undefined };
  };

  it("creates a needs-recovery profile without inventing a recipe, idempotently", () => {
    const runs = [legacyRun(SEPOLIA), legacyRun(CHIADO)];
    const [p, ...rest] = legacyProfilesFromMigrations(SOURCE, "testnet", runs);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ status: "needs_recovery", recipe: null, commitment: null, safeAddress: null });
    expect(p!.legacy!.chains.map((c) => c.chainId)).toEqual([CHIADO, SEPOLIA]);
    expect(parseProfile(p).ok).toBe(true);
    const once = withLegacyProfiles([], SOURCE, "testnet", runs);
    expect(withLegacyProfiles(once, SOURCE, "testnet", runs)).toHaveLength(1);
  });

  it("recovers only when chain state reproduces the recorded address", async () => {
    const [p] = legacyProfilesFromMigrations(SOURCE, "testnet", [legacyRun(SEPOLIA), legacyRun(CHIADO)]);
    chain.inspection.set(SEPOLIA, deployedSafe());
    chain.inspection.set(CHIADO, deployedSafe());
    const r = await recoverLegacyProfile(p!, client);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile).toMatchObject({ status: "active", safeAddress: profile().safeAddress });
      expect(r.profile.deployments.map((d) => d.how)).toEqual(["legacy_record", "legacy_record"]);
    }
  });

  it("refuses recovery for mixed versions, a different address or an unreachable network", async () => {
    const [mixed] = legacyProfilesFromMigrations(SOURCE, "testnet", [legacyRun(SEPOLIA), legacyRun(CHIADO, "1.4.1")]);
    expect((await recoverLegacyProfile(mixed!, client)).ok).toBe(false);
    const [wrong] = legacyProfilesFromMigrations(SOURCE, "testnet", [legacyRun(SEPOLIA, "1.3.0", OWNER_B)]);
    expect((await recoverLegacyProfile(wrong!, client)).ok).toBe(false);
    const [p] = legacyProfilesFromMigrations(SOURCE, "testnet", [legacyRun(SEPOLIA), legacyRun(CHIADO)]);
    chain.unreachable.add(CHIADO);
    chain.inspection.set(SEPOLIA, deployedSafe());
    const r = await recoverLegacyProfile(p!, client);
    expect(r.ok).toBe(false);
  });
});
