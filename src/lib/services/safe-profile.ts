import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { proxyFactoryAbi } from "@/lib/abis";
import { chainsForEnvironment, findChain } from "@/lib/chains/registry";
import {
  deploymentRecipeSchema,
  emptyWatchState,
  profileExportSchema,
  PROFILE_SCHEMA_VERSION,
  RECIPE_DERIVATION,
  safeProfileSchema,
  type ChainDeployment,
  type DeploymentRecipe,
  type GovernanceSnapshot,
  type SafeProfile,
} from "@/lib/domain/profile";
import type {
  ChainSafeTarget,
  Environment,
  Migration,
  SafeConfig,
  SafeContractSet,
  SafeInspection,
  SupportedSafeVersion,
} from "@/lib/domain/types";
import { withHandledFromMigration } from "./late-arrivals";
import { compareSafeToConfig, inspectSafe } from "./onchain-verification";
import {
  canonicalContractSet,
  computeSafeAddress,
  encodeSetupInitializer,
  predictSafe,
  verifyCanonicalContracts,
} from "./safe-deployment";
import { buildSafeConfig, safeConfigHash } from "./signer-configuration";

/* -------------------------------------------------------------------------- */
/*                                   Recipe                                   */
/* -------------------------------------------------------------------------- */

export const RECIPE_COMMITMENT_TAG = "safe-migrator/deployment-recipe/v1";

/**
 * Commitment to everything that determines the Safe address. Owners, threshold and salt enter
 * through the exact initializer and salt nonce; the version, contracts and creation code are bound
 * explicitly so a recipe for another version can never collide with this one.
 */
export function recipeCommitment(r: Omit<DeploymentRecipe, "proxyCreationCode">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        RECIPE_COMMITMENT_TAG,
        r.derivation,
        r.safeVersion,
        r.singletonVariant,
        r.factory,
        r.singleton,
        r.fallbackHandler,
        keccak256(r.initializer),
        BigInt(r.saltNonce),
        r.proxyCreationCodeHash,
      ],
    ),
  );
}

/** The CREATE2 address a recipe deploys to, computed offline from the recipe alone. */
export function recipeAddress(r: DeploymentRecipe): Address {
  return computeSafeAddress({
    factory: r.factory,
    singleton: r.singleton,
    initializer: r.initializer,
    saltNonce: BigInt(r.saltNonce),
    proxyCreationCode: r.proxyCreationCode,
  });
}

export function buildRecipe(config: SafeConfig, version: SupportedSafeVersion, proxyCreationCode: Hex): DeploymentRecipe {
  const c = canonicalContractSet(version);
  return {
    derivation: RECIPE_DERIVATION,
    safeVersion: version,
    singletonVariant: "l2",
    factory: c.proxyFactory,
    singleton: c.singleton,
    fallbackHandler: c.fallbackHandler,
    initializer: encodeSetupInitializer(config, c.fallbackHandler).toLowerCase() as Hex,
    saltNonce: config.saltNonce,
    proxyCreationCode: proxyCreationCode.toLowerCase() as Hex,
    proxyCreationCodeHash: keccak256(proxyCreationCode),
  };
}

/**
 * Checks a recipe against the configuration it claims to deploy: canonical contracts for its
 * version, an owners/threshold-only setup, the same salt and an intact creation-code hash.
 * Returns human-readable problems; empty means consistent.
 */
export function validateRecipe(r: DeploymentRecipe, original: SafeConfig): string[] {
  const issues: string[] = [];
  const canonical = canonicalContractSet(r.safeVersion);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(r.factory, canonical.proxyFactory)) issues.push(`Factory is not the canonical v${r.safeVersion} proxy factory.`);
  if (!eq(r.singleton, canonical.singleton)) issues.push(`Singleton is not the canonical v${r.safeVersion} L2 singleton.`);
  if (!eq(r.fallbackHandler, canonical.fallbackHandler)) issues.push(`Fallback handler is not the canonical v${r.safeVersion} handler.`);
  if (keccak256(r.proxyCreationCode).toLowerCase() !== r.proxyCreationCodeHash.toLowerCase()) issues.push("Proxy creation code does not match its hash.");
  if (r.saltNonce !== original.saltNonce) issues.push("Recipe salt differs from the profile's salt.");
  let expected: Hex | null = null;
  try {
    expected = encodeSetupInitializer(buildSafeConfig(original.owners, original.threshold, original.saltNonce), r.fallbackHandler);
  } catch (e) {
    issues.push(`Original configuration is invalid: ${(e as Error).message}`);
  }
  if (expected && expected.toLowerCase() !== r.initializer.toLowerCase()) {
    issues.push("Initializer is not the owners/threshold-only setup of the original configuration.");
  }
  return issues;
}

/**
 * Builds a recipe from onchain-verified contracts on one chain: canonical bytecode for the version
 * and the factory's actual proxy creation code.
 */
export async function pinRecipe(client: PublicClient, chainId: number, config: SafeConfig, version: SupportedSafeVersion) {
  if ((await client.getChainId()) !== chainId) throw new Error(`RPC is not on chain ${chainId}.`);
  const check = await verifyCanonicalContracts(client, version);
  if (!check.ok) throw new Error(check.issues.join(" "));
  const code = await client.readContract({ address: check.contracts.proxyFactory, abi: proxyFactoryAbi, functionName: "proxyCreationCode" });
  const recipe = buildRecipe(config, version, code);
  return { recipe, commitment: recipeCommitment(recipe), address: recipeAddress(recipe) };
}

/* -------------------------------------------------------------------------- */
/*                                  Profiles                                  */
/* -------------------------------------------------------------------------- */

export function newProfileId(): string {
  return crypto.randomUUID();
}

export function createProfile(params: {
  id?: string;
  source: Address;
  environment: Environment;
  config: SafeConfig;
  recipe: DeploymentRecipe;
  status: "proposed" | "active";
  label?: string | null;
  now?: number;
}): SafeProfile {
  const issues = validateRecipe(params.recipe, params.config);
  if (issues.length) throw new Error(`Refusing to pin an inconsistent recipe: ${issues.join(" ")}`);
  const now = params.now ?? Date.now();
  return {
    kind: "safe-migrator/safe-profile",
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: params.id ?? newProfileId(),
    source: getAddress(params.source),
    environment: params.environment,
    label: params.label ?? null,
    createdAt: now,
    updatedAt: now,
    status: params.status,
    original: { owners: [...params.config.owners], threshold: params.config.threshold, saltNonce: params.config.saltNonce },
    recipe: params.recipe,
    commitment: recipeCommitment(params.recipe),
    safeAddress: recipeAddress(params.recipe),
    chainNotes: [],
    deployments: [],
    snapshots: [],
    runIds: [],
    manualImports: [],
    monitoring: { autoCheck: false, intervalMinutes: 15 },
    watch: emptyWatchState(),
    readiness: { outgoing: [], acknowledgedTestTransaction: null },
    legacy: null,
  };
}

export function isPinned(p: SafeProfile): p is SafeProfile & { recipe: DeploymentRecipe; commitment: Hex; safeAddress: Address } {
  return p.status !== "needs_recovery" && !!p.recipe && !!p.commitment && !!p.safeAddress;
}

/** True when the draft configuration is exactly the profile's original configuration. */
export function profileMatchesConfig(p: SafeProfile, config: SafeConfig | null): boolean {
  return !!config && safeConfigHash(config) === safeConfigHash(p.original);
}

export type ParseResult = { ok: true; profile: SafeProfile } | { ok: false; reason: string };

/**
 * Parses untrusted data (localStorage or an imported file) into a profile and re-derives every
 * identity value. Anything inconsistent is rejected, never repaired.
 */
export function parseProfile(raw: unknown, expect?: { source?: Address; environment?: Environment }): ParseResult {
  const parsed = safeProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `Invalid profile: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "schema mismatch"}.` };
  }
  const p = parsed.data;
  if (expect?.source && p.source.toLowerCase() !== expect.source.toLowerCase()) {
    return { ok: false, reason: "This profile belongs to a different source wallet." };
  }
  if (expect?.environment && p.environment !== expect.environment) {
    return { ok: false, reason: `This profile is for ${p.environment === "testnet" ? "testnets" : "production networks"}.` };
  }
  let config: SafeConfig;
  try {
    config = buildSafeConfig(p.original.owners, p.original.threshold, p.original.saltNonce);
  } catch (e) {
    return { ok: false, reason: `Invalid owner configuration: ${(e as Error).message}.` };
  }
  if (config.owners.some((o, i) => o !== p.original.owners[i])) return { ok: false, reason: "Owners are not in canonical sorted order." };

  const envChains = new Set(chainsForEnvironment(p.environment).map((c) => c.id));
  const chainIds = [...p.deployments.map((d) => d.chainId), ...p.snapshots.map((s) => s.chainId), ...p.chainNotes.map((n) => n.chainId)];
  if (chainIds.some((id) => !envChains.has(id))) return { ok: false, reason: "Profile references a network outside its environment." };

  if (p.status === "needs_recovery") {
    if (p.recipe || p.commitment || p.safeAddress) return { ok: false, reason: "A profile needing recovery must not carry a recipe." };
    return { ok: true, profile: p };
  }
  if (!p.recipe || !p.commitment || !p.safeAddress) return { ok: false, reason: "Pinned profile is missing its deployment recipe." };
  const recipeCheck = deploymentRecipeSchema.safeParse(p.recipe);
  if (!recipeCheck.success) return { ok: false, reason: "Invalid deployment recipe." };
  const issues = validateRecipe(p.recipe, config);
  if (issues.length) return { ok: false, reason: `Deployment recipe rejected: ${issues.join(" ")}` };
  if (recipeCommitment(p.recipe) !== p.commitment) return { ok: false, reason: "Deployment commitment does not match the recipe." };
  const address = recipeAddress(p.recipe);
  if (address !== p.safeAddress) return { ok: false, reason: "Recorded Safe address does not match the recipe." };
  if (p.deployments.some((d) => d.address !== address) || p.snapshots.some((s) => s.address !== address)) {
    return { ok: false, reason: "A recorded deployment points to a different address than the recipe." };
  }
  return { ok: true, profile: p };
}

/* -------------------------------------------------------------------------- */
/*                         Pinned per-chain resolution                        */
/* -------------------------------------------------------------------------- */

const short = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 160);

function base(chainId: number, p: SafeProfile, contracts: SafeContractSet | null): ChainSafeTarget {
  return {
    chainId,
    safeVersion: p.recipe?.safeVersion ?? null,
    contracts,
    predictedAddress: null,
    status: "error",
    inspection: null,
    issues: [],
    pinned: true,
  };
}

/**
 * Resolves a network for a saved profile using ONLY its pinned recipe. The version is never
 * renegotiated: if the network cannot reproduce the recipe the network is blocked, never given a
 * different Safe. RPC failures are reported as `unavailable`, distinct from incompatibility.
 */
export async function resolvePinnedTarget(chainId: number, client: PublicClient, profile: SafeProfile): Promise<ChainSafeTarget> {
  if (!isPinned(profile)) {
    return { ...base(chainId, profile, null), issues: ["This saved Safe has no trusted deployment recipe yet. Recover it first."] };
  }
  const recipe = profile.recipe;
  const contracts = canonicalContractSet(recipe.safeVersion);
  const out = base(chainId, profile, contracts);
  const chain = findChain(chainId);
  if (!chain || chain.environment !== profile.environment) return { ...out, status: "incompatible", issues: ["Network is not part of this profile's environment."] };

  let check;
  let creationCode: Hex;
  try {
    if ((await client.getChainId()) !== chainId) return { ...out, unavailable: true, issues: [`RPC is not serving ${chain.name}.`] };
    check = await verifyCanonicalContracts(client, recipe.safeVersion);
    if (!check.ok) {
      return {
        ...out,
        status: "incompatible",
        issues: [
          ...check.issues,
          `This Safe is pinned to v${recipe.safeVersion}. The app will not switch versions on ${chain.name}, because that would create a Safe at a different address.`,
        ],
      };
    }
    creationCode = await client.readContract({ address: recipe.factory, abi: proxyFactoryAbi, functionName: "proxyCreationCode" });
  } catch (e) {
    return { ...out, unavailable: true, issues: [`Could not read ${chain.name}: ${short(e)}. Status unknown, not incompatible.`] };
  }
  if (keccak256(creationCode).toLowerCase() !== recipe.proxyCreationCodeHash.toLowerCase()) {
    return { ...out, status: "incompatible", issues: [`The proxy factory on ${chain.name} uses different creation code; the pinned address cannot be reproduced there.`] };
  }
  const independent = recipeAddress({ ...recipe, proxyCreationCode: creationCode.toLowerCase() as Hex });
  if (independent !== profile.safeAddress) {
    return { ...out, status: "error", issues: [`Recipe computes ${independent} but the profile records ${profile.safeAddress}. The saved profile may have been tampered with.`] };
  }
  try {
    const prediction = await predictSafe(chainId, client, profile.original, recipe.safeVersion, contracts);
    if (prediction.issues.length || prediction.sdkAddress !== profile.safeAddress) {
      return { ...out, status: "error", issues: [...prediction.issues, `Protocol Kit predicts ${prediction.sdkAddress}, expected ${profile.safeAddress}.`] };
    }
  } catch (e) {
    return { ...out, unavailable: true, issues: [`Prediction failed on ${chain.name}: ${short(e)}`] };
  }
  let inspection: SafeInspection;
  try {
    inspection = await inspectSafe(client, profile.safeAddress);
  } catch (e) {
    return { ...out, predictedAddress: profile.safeAddress, unavailable: true, issues: [`Could not inspect the Safe address: ${short(e)}`] };
  }
  const result: ChainSafeTarget = { ...out, predictedAddress: profile.safeAddress, inspection, status: "not_deployed", issues: [] };
  if (!inspection.hasCode) return result;
  const g = classifyDeployed(inspection, profile.original, contracts);
  return { ...result, status: g.status, issues: g.issues };
}

/**
 * Interprets code found at the pinned address. CREATE2 binds the address to the recipe's
 * initializer, so a Safe proxy here started with the original owners; any difference now is a
 * governance change made by its owners. Code that does not behave like a Safe is a conflict.
 */
export function classifyDeployed(
  inspection: SafeInspection,
  original: SafeConfig,
  contracts: SafeContractSet,
): { status: "deployed_matching" | "deployed_governance_changed" | "deployed_mismatch"; issues: string[] } {
  if (!inspection.isSafe) return { status: "deployed_mismatch", issues: ["A contract exists at this address but it does not behave like a Safe."] };
  const issues = compareSafeToConfig(inspection, original, contracts);
  return issues.length ? { status: "deployed_governance_changed", issues } : { status: "deployed_matching", issues: [] };
}

export function snapshotFromInspection(chainId: number, inspection: SafeInspection, original: SafeConfig, contracts: SafeContractSet, now = Date.now()): GovernanceSnapshot {
  const issues = inspection.isSafe ? compareSafeToConfig(inspection, original, contracts) : ["Not a Safe."];
  return {
    chainId,
    address: getAddress(inspection.address),
    blockNumber: inspection.blockNumber,
    blockHash: inspection.blockHash ? (inspection.blockHash.toLowerCase() as Hex) : null,
    observedAt: now,
    isSafe: inspection.isSafe,
    owners: inspection.owners,
    threshold: inspection.threshold,
    version: inspection.version,
    singleton: inspection.singleton,
    fallbackHandler: inspection.fallbackHandler,
    guard: inspection.guard,
    modules: inspection.modules,
    nonce: inspection.nonce,
    matchesOriginal: inspection.isSafe && issues.length === 0,
    issues: issues.slice(0, 20),
  };
}

/** Replaces the snapshot for one chain (latest observation wins). */
export function withSnapshot(p: SafeProfile, s: GovernanceSnapshot): SafeProfile {
  return { ...p, snapshots: [...p.snapshots.filter((x) => x.chainId !== s.chainId), s].sort((a, b) => a.chainId - b.chainId), updatedAt: Date.now() };
}

export function withDeployment(p: SafeProfile, d: ChainDeployment): SafeProfile {
  const existing = p.deployments.find((x) => x.chainId === d.chainId);
  // The first recorded deployment is history; a later "existing" observation does not overwrite a known tx hash.
  if (existing && (existing.txHash || !d.txHash)) return p;
  return { ...p, deployments: [...p.deployments.filter((x) => x.chainId !== d.chainId), d].sort((a, b) => a.chainId - b.chainId), updatedAt: Date.now() };
}

export type GovernanceState = "matches_original" | "diverged" | "unknown" | "not_deployed";

export interface ChainGovernance {
  chainId: number;
  state: GovernanceState;
  snapshot: GovernanceSnapshot | null;
  /** Age of the snapshot when it was evaluated. */
  stale: boolean;
}

export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** Per-chain governance from recorded snapshots. Same-address Safes are never assumed to share state. */
export function governanceByChain(p: SafeProfile, now = Date.now()): ChainGovernance[] {
  const deployed = new Set(p.deployments.map((d) => d.chainId));
  const chains = [...new Set([...deployed, ...p.snapshots.map((s) => s.chainId)])].sort((a, b) => a - b);
  return chains.map((chainId) => {
    const snapshot = p.snapshots.find((s) => s.chainId === chainId) ?? null;
    if (!snapshot) return { chainId, state: "unknown" as const, snapshot: null, stale: true };
    const state: GovernanceState = !snapshot.isSafe ? "not_deployed" : snapshot.matchesOriginal ? "matches_original" : "diverged";
    return { chainId, state, snapshot, stale: now - snapshot.observedAt > SNAPSHOT_STALE_MS };
  });
}

/* -------------------------------------------------------------------------- */
/*                         Linking runs to the profile                         */
/* -------------------------------------------------------------------------- */

/** Records deployments and verification snapshots a run established. Never removes history. */
export function syncProfileWithMigration(p: SafeProfile, m: Migration): SafeProfile {
  if (!isPinned(p) || m.profileId !== p.id) return p;
  const version = p.recipe.safeVersion;
  const safeAddress = p.safeAddress;
  let next: SafeProfile = p.runIds.includes(m.id) ? p : { ...p, runIds: [...p.runIds, m.id], status: "active", updatedAt: Date.now() };
  for (const c of m.chains) {
    if (c.safeAddress !== safeAddress) continue;
    const deploy = c.actions.find((a) => a.kind === "deploy_safe");
    const verified = deploy && (deploy.status === "verified" || deploy.status === "skipped");
    if (verified && c.safeVerification?.isSafe) {
      next = withDeployment(next, {
        chainId: c.chainId,
        address: safeAddress,
        txHash: deploy.txHash ? (deploy.txHash.toLowerCase() as Hex) : null,
        how: deploy.txHash ? "deployed" : "existing",
        runId: m.id,
        recordedAt: Date.now(),
      });
    }
    const insp = c.safeVerification;
    if (insp?.hasCode) {
      const known = next.snapshots.find((s) => s.chainId === c.chainId);
      if (!known || BigInt(known.blockNumber) < BigInt(insp.blockNumber)) {
        next = withSnapshot(next, snapshotFromInspection(c.chainId, insp, p.original, canonicalContractSet(version)));
      }
    }
  }
  if (m.runState === "finished") {
    const watch = withHandledFromMigration(next.watch, m);
    if (JSON.stringify(watch) !== JSON.stringify(next.watch)) next = { ...next, watch, updatedAt: Date.now() };
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/*                               Legacy records                               */
/* -------------------------------------------------------------------------- */

/**
 * Builds conservative profiles from pre-v1.5 migration records: one per distinct configuration.
 * Nothing is inferred beyond what the records state. The recipe stays empty until
 * `recoverLegacyProfile` re-derives it from verified chain state.
 */
export function legacyProfilesFromMigrations(source: Address, environment: Environment, migrations: readonly Migration[], now = Date.now()): SafeProfile[] {
  const envChains = new Set(chainsForEnvironment(environment).map((c) => c.id));
  const groups = new Map<string, Migration[]>();
  for (const m of migrations) {
    if (m.environment !== environment || m.source.toLowerCase() !== source.toLowerCase() || m.profileId) continue;
    try {
      const key = safeConfigHash(buildSafeConfig(m.safeConfig.owners, m.safeConfig.threshold, m.safeConfig.saltNonce));
      groups.set(key, [...(groups.get(key) ?? []), m]);
    } catch {
      // Unusable record: leave it alone; it stays visible in history.
    }
  }
  return [...groups.values()].map((runs) => {
    const first = runs[0]!;
    const config = buildSafeConfig(first.safeConfig.owners, first.safeConfig.threshold, first.safeConfig.saltNonce);
    const chains = new Map<number, { chainId: number; safeAddress: Address; safeVersion: SupportedSafeVersion; deployTxHash: Hex | null }>();
    for (const m of runs) {
      for (const c of m.chains) {
        if (!envChains.has(c.chainId)) continue;
        const tx = c.actions.find((a) => a.kind === "deploy_safe")?.txHash ?? null;
        const prior = chains.get(c.chainId);
        if (!prior || (!prior.deployTxHash && tx)) {
          chains.set(c.chainId, { chainId: c.chainId, safeAddress: getAddress(c.safeAddress), safeVersion: c.safeVersion, deployTxHash: tx ? (tx.toLowerCase() as Hex) : null });
        }
      }
    }
    return {
      kind: "safe-migrator/safe-profile",
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id: `legacy-${safeConfigHash(config).slice(2, 26)}`,
      source: getAddress(source),
      environment,
      label: null,
      createdAt: Math.min(...runs.map((m) => m.createdAt)),
      updatedAt: now,
      status: "needs_recovery",
      original: config,
      recipe: null,
      commitment: null,
      safeAddress: null,
      chainNotes: [],
      deployments: [],
      snapshots: [],
      runIds: runs.map((m) => m.id),
      manualImports: [],
      monitoring: { autoCheck: false, intervalMinutes: 15 },
      watch: emptyWatchState(),
      readiness: { outgoing: [], acknowledgedTestTransaction: null },
      legacy: {
        reason: "Created before saved Safe profiles existed. The deployment recipe must be re-derived from chain state before this Safe can be extended or swept to.",
        migrationIds: runs.map((m) => m.id),
        chains: [...chains.values()].sort((a, b) => a.chainId - b.chainId),
      },
    } satisfies SafeProfile;
  });
}

export type RecoveryResult = { ok: true; profile: SafeProfile } | { ok: false; reason: string };

/**
 * Re-derives a legacy profile's recipe from verified chain state. It succeeds only when every
 * recorded network used the same Safe version and address, the canonical contracts verify, the
 * recipe reproduces the recorded address, and a Safe from that recipe is deployed there.
 */
export async function recoverLegacyProfile(p: SafeProfile, clientFor: (chainId: number) => PublicClient): Promise<RecoveryResult> {
  if (p.status !== "needs_recovery" || !p.legacy) return { ok: false, reason: "Profile does not need recovery." };
  const recorded = p.legacy.chains;
  if (recorded.length === 0) return { ok: false, reason: "The old records contain no network to verify against." };
  const versions = new Set(recorded.map((c) => c.safeVersion));
  const addresses = new Set(recorded.map((c) => c.safeAddress));
  if (versions.size > 1 || addresses.size > 1) {
    return { ok: false, reason: "The old records used different Safe versions or addresses per network, so no single recipe describes them. They stay viewable as history." };
  }
  const version = recorded[0]!.safeVersion;
  const address = recorded[0]!.safeAddress;
  let pinned;
  let pinErr = "";
  for (const c of recorded) {
    try {
      pinned = await pinRecipe(clientFor(c.chainId), c.chainId, p.original, version);
      break;
    } catch (e) {
      pinErr = short(e);
    }
  }
  if (!pinned) return { ok: false, reason: `Could not verify the Safe contracts on any recorded network: ${pinErr}` };
  if (pinned.address !== address) return { ok: false, reason: `The recorded address ${address} does not match the recipe (${pinned.address}).` };

  let next: SafeProfile = {
    ...p,
    status: "active",
    recipe: pinned.recipe,
    commitment: pinned.commitment,
    safeAddress: pinned.address,
    legacy: { ...p.legacy, reason: "Recovered from pre-v1.5 records and verified chain state." },
    updatedAt: Date.now(),
  };
  for (const c of recorded) {
    const target = await resolvePinnedTarget(c.chainId, clientFor(c.chainId), next);
    if (target.unavailable) return { ok: false, reason: `${findChain(c.chainId)?.name ?? c.chainId}: ${target.issues.join(" ")}` };
    if (target.status === "not_deployed") continue;
    if (target.status !== "deployed_matching" && target.status !== "deployed_governance_changed") {
      return { ok: false, reason: `${findChain(c.chainId)?.name ?? c.chainId}: ${target.issues.join(" ")}` };
    }
    next = withDeployment(next, { chainId: c.chainId, address: pinned.address, txHash: c.deployTxHash, how: "legacy_record", runId: null, recordedAt: Date.now() });
    if (target.inspection) next = withSnapshot(next, snapshotFromInspection(c.chainId, target.inspection, p.original, canonicalContractSet(version)));
  }
  const check = parseProfile(next);
  return check.ok ? { ok: true, profile: check.profile } : { ok: false, reason: check.reason };
}

/* -------------------------------------------------------------------------- */
/*                               Export / import                              */
/* -------------------------------------------------------------------------- */

export const PROFILE_IMPORT_MAX_BYTES = 512 * 1024;

export function exportProfile(p: SafeProfile, now = Date.now()): string {
  return JSON.stringify({ kind: "safe-migrator/safe-profile-export", schemaVersion: PROFILE_SCHEMA_VERSION, exportedAt: now, profile: p }, null, 2);
}

/**
 * Imports a profile file. Deployment records are kept as claims (every use re-reads the chain) but
 * governance snapshots are dropped: observations from a file are not observations of the chain.
 */
export function importProfile(text: string, expect: { source: Address; environment: Environment }): ParseResult {
  if (new TextEncoder().encode(text).length > PROFILE_IMPORT_MAX_BYTES) return { ok: false, reason: "File is too large to be a Safe profile." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "File is not valid JSON." };
  }
  const envelope = profileExportSchema.safeParse(json);
  if (!envelope.success) return { ok: false, reason: "Not a Safe Migrator profile export." };
  const parsed = parseProfile(envelope.data.profile, expect);
  if (!parsed.ok) return parsed;
  return { ok: true, profile: { ...parsed.profile, snapshots: [], watch: { ...parsed.profile.watch, checks: [], lastCheckedAt: null }, readiness: { outgoing: [], acknowledgedTestTransaction: null } } };
}

/** Short label for UI and file names. */
export function profileTitle(p: SafeProfile): string {
  return p.label || (p.safeAddress ? `Safe ${p.safeAddress.slice(0, 6)}…${p.safeAddress.slice(-4)}` : "Saved Safe (needs recovery)");
}

/* -------------------------------------------------------------------------- */
/*                          Choosing a profile for a run                       */
/* -------------------------------------------------------------------------- */

/**
 * Picks the profile a new run belongs to: an existing profile with the same commitment, otherwise
 * a new one. Legacy (needs-recovery) profiles whose records all point at exactly this address and
 * version are merged into it, which is their recovery through freshly verified chain state.
 */
export function chooseProfileForRun(params: {
  profiles: readonly SafeProfile[];
  source: Address;
  environment: Environment;
  config: SafeConfig;
  pinned: { recipe: DeploymentRecipe; commitment: Hex; address: Address };
  /** "proposed" when pinning only for owner verification; a run makes it "active". */
  status?: "proposed" | "active";
  now?: number;
}): { profile: SafeProfile; replaces: string[] } {
  const { pinned } = params;
  const status = params.status ?? "active";
  const same = params.profiles.find((p) => isPinned(p) && p.commitment === pinned.commitment && p.environment === params.environment);
  if (same) return { profile: same.status === "proposed" && status === "active" ? { ...same, status: "active", updatedAt: Date.now() } : same, replaces: [] };

  let profile = createProfile({ source: params.source, environment: params.environment, config: params.config, recipe: pinned.recipe, status, now: params.now });
  const hash = safeConfigHash(params.config);
  const legacy = params.profiles.filter(
    (p) =>
      p.status === "needs_recovery" &&
      p.environment === params.environment &&
      safeConfigHash(p.original) === hash &&
      !!p.legacy &&
      p.legacy.chains.every((c) => c.safeAddress === pinned.address && c.safeVersion === pinned.recipe.safeVersion),
  );
  for (const l of legacy) {
    profile = {
      ...profile,
      status: "active",
      createdAt: Math.min(profile.createdAt, l.createdAt),
      runIds: [...new Set([...l.runIds, ...profile.runIds])],
      legacy: { ...l.legacy!, reason: "Merged pre-v1.5 records whose address matches this pinned recipe." },
    };
    for (const c of l.legacy!.chains) {
      profile = withDeployment(profile, { chainId: c.chainId, address: pinned.address, txHash: c.deployTxHash, how: "legacy_record", runId: null, recordedAt: Date.now() });
    }
  }
  return { profile, replaces: legacy.map((l) => l.id) };
}

/** The reviewed security state of an existing Safe, for a run that sends assets into it. */
export function expectedGovernanceFrom(inspection: SafeInspection) {
  return {
    owners: [...inspection.owners],
    threshold: inspection.threshold,
    singleton: inspection.singleton,
    fallbackHandler: inspection.fallbackHandler,
    guard: inspection.guard,
    modules: [...inspection.modules],
    observedAtBlock: inspection.blockNumber,
  };
}
