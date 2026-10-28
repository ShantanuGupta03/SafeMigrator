import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { findChain } from "@/lib/chains/registry";

/*
 * Durable, versioned records that outlive a single migration run. Everything here can come from
 * localStorage or an imported file, so it is parsed with runtime schemas and then re-checked for
 * internal consistency (see `safe-profile.ts`). Parsing never trusts derived values: commitments and
 * addresses are recomputed from the recipe.
 */

export const PROFILE_SCHEMA_VERSION = 1 as const;
/** CREATE2 via `SafeProxyFactory.createProxyWithNonce`; salt = keccak256(keccak256(initializer) ‖ saltNonce). */
export const RECIPE_DERIVATION = "safe-proxy-factory-create2-v1" as const;

export const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "Invalid address")
  .transform((v) => getAddress(v) as Address);

export const hexSchema = (maxBytes: number) =>
  z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})*$/, "Invalid hex")
    .refine((v) => (v.length - 2) / 2 <= maxBytes, `Hex longer than ${maxBytes} bytes`)
    .transform((v) => v.toLowerCase() as Hex);

export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Expected 32 bytes")
  .transform((v) => v.toLowerCase() as Hex);

export const uintStringSchema = z.string().regex(/^\d{1,78}$/, "Expected an unsigned integer string");

/** A supported network ID; unknown chains are rejected rather than ignored. */
export const chainIdSchema = z
  .number()
  .int()
  .positive()
  .refine((id) => !!findChain(id), "Unsupported network");

export const timestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);

export const idSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Invalid id");

export const environmentSchema = z.enum(["testnet", "mainnet"]);
export const safeVersionSchema = z.enum(["1.4.1", "1.3.0"]);

export const safeConfigSchema = z.object({
  owners: z.array(addressSchema).min(1).max(10),
  threshold: z.number().int().min(1).max(10),
  saltNonce: uintStringSchema,
});

/**
 * Everything that determines the Safe address, pinned once accepted. Later runs and network
 * extensions reuse it verbatim; they never renegotiate the version or contracts.
 */
export const deploymentRecipeSchema = z.object({
  derivation: z.literal(RECIPE_DERIVATION),
  safeVersion: safeVersionSchema,
  singletonVariant: z.literal("l2"),
  factory: addressSchema,
  singleton: addressSchema,
  fallbackHandler: addressSchema,
  /** Exact `Safe.setup` calldata. */
  initializer: hexSchema(4096),
  saltNonce: uintStringSchema,
  /** The factory's `proxyCreationCode()`, kept so the address can be recomputed offline. */
  proxyCreationCode: hexSchema(8192),
  proxyCreationCodeHash: bytes32Schema,
});
export type DeploymentRecipe = z.infer<typeof deploymentRecipeSchema>;

export const chainDeploymentSchema = z.object({
  chainId: chainIdSchema,
  address: addressSchema,
  txHash: bytes32Schema.nullable(),
  /** deployed: by a run of this app · existing: found already deployed · legacy_record: from a pre-v1.5 run record. */
  how: z.enum(["deployed", "existing", "legacy_record"]),
  runId: z.string().max(64).nullable(),
  recordedAt: timestampSchema,
});
export type ChainDeployment = z.infer<typeof chainDeploymentSchema>;

/** One onchain observation of a deployed Safe's governance. Observations are never edited, only replaced by newer ones. */
export const governanceSnapshotSchema = z.object({
  chainId: chainIdSchema,
  address: addressSchema,
  blockNumber: uintStringSchema,
  blockHash: bytes32Schema.nullable(),
  observedAt: timestampSchema,
  isSafe: z.boolean(),
  owners: z.array(addressSchema).max(50),
  threshold: z.number().int().min(0).max(50),
  version: z.string().max(32).nullable(),
  singleton: addressSchema.nullable(),
  fallbackHandler: addressSchema.nullable(),
  guard: addressSchema.nullable(),
  modules: z.array(addressSchema).max(50),
  nonce: uintStringSchema.nullable(),
  /** Owners, threshold and security settings equal the original deployment recipe. */
  matchesOriginal: z.boolean(),
  issues: z.array(z.string().max(500)).max(20),
});
export type GovernanceSnapshot = z.infer<typeof governanceSnapshotSchema>;

export const manualImportSchema = z.object({
  chainId: chainIdSchema,
  standard: z.enum(["erc20", "erc721", "erc1155"]),
  contract: addressSchema,
  tokenId: uintStringSchema.nullable(),
});

/** Assets the user handled or chose to ignore, so late-arrival checks do not alert for them again. */
export const handledAssetSchema = z.object({
  assetId: z.string().max(200),
  chainId: chainIdSchema,
  /** Source balance when it was last handled (migrated, ignored, retained as dust). */
  balance: uintStringSchema,
  reason: z.enum(["migrated", "ignored", "excluded", "retained"]),
  at: timestampSchema,
});
export type HandledAsset = z.infer<typeof handledAssetSchema>;

export const pendingArrivalSchema = z.object({
  assetId: z.string().max(200),
  chainId: chainIdSchema,
  standard: z.enum(["native", "erc20", "erc721", "erc1155"]),
  contract: addressSchema.nullable(),
  tokenId: uintStringSchema.nullable(),
  label: z.string().max(200),
  decimals: z.number().int().min(0).max(255),
  balance: uintStringSchema,
  previousBalance: uintStringSchema.nullable(),
  kind: z.enum(["new", "increased"]),
  classification: z.enum(["transferable", "specialized", "non_transferable", "unsupported", "suspicious"]),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
});
export type PendingArrival = z.infer<typeof pendingArrivalSchema>;

export const chainCheckSchema = z.object({
  chainId: chainIdSchema,
  checkedAt: timestampSchema,
  status: z.enum(["ok", "partial", "error"]),
  note: z.string().max(1000).nullable(),
});
export type ChainCheck = z.infer<typeof chainCheckSchema>;

export const watchStateSchema = z.object({
  lastCheckedAt: timestampSchema.nullable(),
  checks: z.array(chainCheckSchema).max(50),
  handled: z.array(handledAssetSchema).max(2000),
  pending: z.array(pendingArrivalSchema).max(500),
});
export type WatchState = z.infer<typeof watchStateSchema>;

export const outgoingEvidenceSchema = z.object({
  chainId: chainIdSchema,
  txHash: bytes32Schema,
  safe: addressSchema,
  blockNumber: uintStringSchema,
  /** Threshold the Safe enforced at the execution block. */
  thresholdAtBlock: z.number().int().min(1).max(50),
  safeTxHash: bytes32Schema,
  verifiedAt: timestampSchema,
});
export type OutgoingEvidence = z.infer<typeof outgoingEvidenceSchema>;

export const readinessRecordSchema = z.object({
  /** Verified onchain: an `ExecutionSuccess` from this Safe. */
  outgoing: z.array(outgoingEvidenceSchema).max(20),
  /** The user says they did it, without evidence. Shown separately from observed evidence. */
  acknowledgedTestTransaction: timestampSchema.nullable(),
});

export const legacyRecordSchema = z.object({
  reason: z.string().max(1000),
  migrationIds: z.array(z.string().max(64)).max(50),
  chains: z
    .array(
      z.object({
        chainId: chainIdSchema,
        safeAddress: addressSchema,
        safeVersion: safeVersionSchema,
        deployTxHash: bytes32Schema.nullable(),
      }),
    )
    .max(50),
});

export const profileStatusSchema = z.enum([
  /** Recipe pinned for owner verification; nothing deployed or run yet. */
  "proposed",
  /** Recipe pinned and at least one run created. */
  "active",
  /** Built from a pre-v1.5 record; no trusted recipe yet. */
  "needs_recovery",
]);
export type ProfileStatus = z.infer<typeof profileStatusSchema>;

export const profileDestinationKindSchema = z.enum(["created", "imported_existing"]);
export type ProfileDestinationKind = z.infer<typeof profileDestinationKindSchema>;

export const safeProfileSchema = z.object({
  kind: z.literal("safe-migrator/safe-profile"),
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  id: idSchema,
  source: addressSchema,
  environment: environmentSchema,
  label: z.string().max(80).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  status: profileStatusSchema,
  /** Created via deployment recipe, or imported as an already-deployed Safe (no cross-network deploy recipe). */
  destinationKind: profileDestinationKindSchema.optional().default("created"),
  /** Owners, threshold and salt the Safe was created with. Never updated when governance changes. */
  original: safeConfigSchema,
  recipe: deploymentRecipeSchema.nullable(),
  commitment: bytes32Schema.nullable(),
  safeAddress: addressSchema.nullable(),
  /** Explicitly recorded per-network differences (for example a network that cannot use the pinned version). */
  chainNotes: z.array(z.object({ chainId: chainIdSchema, note: z.string().max(500) })).max(50),
  deployments: z.array(chainDeploymentSchema).max(50),
  snapshots: z.array(governanceSnapshotSchema).max(50),
  runIds: z.array(z.string().max(64)).max(500),
  manualImports: z.array(manualImportSchema).max(500),
  monitoring: z.object({
    autoCheck: z.boolean(),
    intervalMinutes: z.number().int().min(5).max(120),
  }),
  watch: watchStateSchema,
  readiness: readinessRecordSchema,
  legacy: legacyRecordSchema.nullable(),
});
export type SafeProfile = z.infer<typeof safeProfileSchema>;

export const profileStoreSchema = z.object({
  kind: z.literal("safe-migrator/profile-store"),
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  profiles: z.array(z.unknown()).max(100),
});

export const profileExportSchema = z.object({
  kind: z.literal("safe-migrator/safe-profile-export"),
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  exportedAt: timestampSchema,
  profile: z.unknown(),
});

export function emptyWatchState(): WatchState {
  return { lastCheckedAt: null, checks: [], handled: [], pending: [] };
}
