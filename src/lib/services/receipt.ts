import { sha256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { findChain } from "@/lib/chains/registry";
import { formatAmount, toBigInt } from "@/lib/domain/amounts";
import { addressSchema, bytes32Schema, chainIdSchema, environmentSchema, uintStringSchema } from "@/lib/domain/profile";
import type { ChainMigration, Migration, MigrationAction, NetworkDiscovery, SafeInspection } from "@/lib/domain/types";
import { chainOutcome, migrationOutcome } from "@/lib/state/machine";

/*
 * Versioned migration receipts. One canonical model feeds the JSON export, the PDF and the
 * inspector. Two parts are kept apart:
 *  - `record`: what this run planned, submitted and verified, frozen at the time of the migration;
 *  - `currentState`: an optional, clearly labelled live re-read at export time.
 * A later re-read never rewrites the historical record.
 *
 * Integrity: `integrity.hash` = SHA-256 over the canonical JSON (RFC 8785-style: sorted keys, no
 * whitespace, integers only) of the receipt WITHOUT the `integrity` field. It is a commitment to the
 * content, not a signature, and certifies nothing by itself.
 */

export const RECEIPT_KIND = "safe-migrator/receipt" as const;
export const RECEIPT_SCHEMA_VERSION = 1 as const;
export const RECEIPT_HASH_ALGORITHM = "sha256-jcs-v1" as const;
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*                            Canonical serialization                         */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON: object keys sorted by UTF-16 code units, no insignificant whitespace, strings
 * escaped by JSON.stringify, numbers restricted to safe integers (amounts are decimal strings), and
 * `undefined` rejected so a missing value is always an explicit `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: only safe integers are allowed (got ${value})`);
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries
        .map(([k, v]) => {
          if (v === undefined) throw new Error(`canonicalJson: undefined at "${k}"`);
          return `${JSON.stringify(k)}:${canonicalJson(v)}`;
        })
        .join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

export function receiptHash(receiptWithoutIntegrity: unknown): Hex {
  return sha256(stringToBytes(canonicalJson(receiptWithoutIntegrity)));
}

/* -------------------------------------------------------------------------- */
/*                                    Schema                                  */
/* -------------------------------------------------------------------------- */

const raw = uintStringSchema;
const txHash = bytes32Schema;
const outcomeSchema = z.enum(["complete", "partial", "incomplete", "uncertain"]);
const chainOutcomeSchema = z.enum(["not_started", "in_progress", "completed", "needs_attention", "blocked"]);
const text = (max = 500) => z.string().max(max);

const actionSchema = z.object({
  id: text(300),
  kind: z.enum(["deploy_safe", "transfer_native", "transfer_erc20", "transfer_erc721", "transfer_erc1155"]),
  label: text(200),
  status: text(40),
  contract: addressSchema.nullable(),
  tokenIds: z.array(raw).max(200),
  symbol: text(40),
  decimals: z.number().int().min(0).max(255),
  /** Exact base units. Display strings are separate and derived. */
  amounts: z.object({
    /** User intent at review (exact amount or max ceiling), when recorded. */
    requestedRaw: z.array(raw).max(200).nullable(),
    intentMode: z.enum(["exact", "max"]).nullable(),
    reviewedCeilingRaw: raw.nullable(),
    reviewedRaw: z.array(raw).max(200).nullable(),
    plannedRaw: z.array(raw).max(200),
    verifiedDeltaRaw: raw.nullable(),
    loggedRaw: raw.nullable(),
    sourceRemainingRaw: raw.nullable(),
  }),
  display: z.object({ planned: text(100), verified: text(100).nullable() }),
  txHash: txHash.nullable(),
  callsId: text(200).nullable(),
  feePaidRaw: raw.nullable(),
  evidence: z.enum(["receipt_logs", "log_search", "balance_only", "end_state"]).nullable(),
  verificationBlock: raw.nullable(),
  note: text(1000).nullable(),
  error: z.object({ code: text(40), message: text(1000) }).nullable(),
});

const chainSchema = z.object({
  chainId: chainIdSchema,
  network: text(80),
  nativeSymbol: text(20),
  nativeDecimals: z.number().int().min(0).max(255),
  safeAddress: addressSchema,
  safeVersion: z.enum(["1.4.1", "1.3.0"]),
  strategy: z.enum(["atomic_batch", "sequential"]),
  outcome: chainOutcomeSchema,
  deployment: z.object({
    how: z.enum(["deployed_in_this_run", "already_deployed", "not_completed", "unknown"]),
    txHash: txHash.nullable(),
  }),
  /** The Safe as verified during the run; null when the run never got that far (unknown, not "none"). */
  verifiedAtMigration: z
    .object({
      blockNumber: raw,
      blockHash: txHash.nullable(),
      owners: z.array(addressSchema).max(50),
      threshold: z.number().int().min(0).max(50),
      singleton: addressSchema.nullable(),
      fallbackHandler: addressSchema.nullable(),
      guard: addressSchema.nullable(),
      modules: z.array(addressSchema).max(50),
    })
    .nullable(),
  reviewedGovernance: z.object({ owners: z.array(addressSchema).max(50), threshold: z.number().int().min(0).max(50), observedAtBlock: raw }).nullable(),
  actions: z.array(actionSchema).max(500),
  batches: z
    .array(
      z.object({
        callsId: text(200),
        state: z.enum(["requested", "submitted", "unknown"]),
        statusCode: z.number().int().nullable(),
        atomic: z.boolean().nullable(),
        transactionHashes: z.array(txHash).max(50),
        actionIds: z.array(text(300)).max(500),
        submittedAt: z.number().int().min(0),
      }),
    )
    .max(50),
  fees: z.object({ paidRaw: raw, actionsWithUnknownFee: z.number().int().min(0) }),
});

const currentChainSchema = z.object({
  chainId: chainIdSchema,
  observedAt: z.number().int().min(0),
  blockNumber: raw.nullable(),
  safe: z.object({ isSafe: z.boolean(), owners: z.array(addressSchema).max(50), threshold: z.number().int().min(0).max(50), issues: z.array(text()).max(20) }).nullable(),
  safeHoldings: z.array(z.object({ assetId: text(300), symbol: text(40), balanceRaw: raw, decimals: z.number().int().min(0).max(255) })).max(500).nullable(),
  remainingInSource: z
    .array(z.object({ assetId: text(300), symbol: text(40), balanceRaw: raw, decimals: z.number().int().min(0).max(255), classification: text(40) }))
    .max(500)
    .nullable(),
  error: text(500).nullable(),
});

export const receiptBodySchema = z.object({
  kind: z.literal(RECEIPT_KIND),
  schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
  generatedAt: z.number().int().min(0),
  app: z.object({ name: z.literal("Safe Migrator"), version: text(40).nullable(), commit: text(64).nullable() }),
  record: z.object({
    migrationId: text(64),
    profileId: text(64).nullable(),
    purpose: z.enum(["migration", "extension", "sweep", "unknown"]),
    createdAt: z.number().int().min(0),
    lastUpdatedAt: z.number().int().min(0),
    runState: z.enum(["idle", "running", "paused", "finished"]),
    outcome: outcomeSchema,
    /** Explicit statement of what the outcome covers. */
    outcomeScope: text(500),
    source: addressSchema,
    environment: environmentSchema,
    destination: z.object({
      deploymentCommitment: bytes32Schema.nullable(),
      owners: z.array(addressSchema).max(50),
      threshold: z.number().int().min(1).max(50),
      saltNonce: raw,
    }),
    ownerVerification: z.object({
      verifiedOwners: z.array(addressSchema).max(50),
      method: z.enum(["owner-ack-v2", "legacy-v1", "mixed", "none"]),
      waivedOnTestnet: z.boolean(),
    }),
    scope: z
      .object({
        selectedChainIds: z.array(chainIdSchema).max(50),
        includedChainIds: z.array(chainIdSchema).max(50),
        blockedChains: z.array(z.object({ chainId: chainIdSchema, reasons: z.array(text(1000)).max(20) })).max(50),
        excludedAssets: z
          .array(
            z.object({
              assetId: text(300),
              chainId: chainIdSchema,
              label: text(200),
              amountRaw: raw,
              decimals: z.number().int().min(0).max(255),
              intentMode: z.enum(["exact", "max"]).nullable(),
              requestedRaw: raw.nullable(),
              reason: text(1000).nullable(),
            }),
          )
          .max(500),
        selectedAssets: z
          .array(
            z.object({
              assetId: text(300),
              chainId: chainIdSchema,
              label: text(200),
              amountRaw: raw,
              decimals: z.number().int().min(0).max(255),
              intentMode: z.enum(["exact", "max"]).nullable(),
              requestedRaw: raw.nullable(),
            }),
          )
          .max(500)
          .nullable(),
        partialAcknowledged: z.boolean(),
        incompleteDiscovery: z.array(z.object({ chainId: chainIdSchema, note: text(1000) })).max(50),
        plannedAt: z.number().int().min(0),
      })
      .nullable(),
    chains: z.array(chainSchema).max(50),
    discrepancies: z.array(z.object({ chainId: chainIdSchema, actionId: text(300), label: text(200), expectedRaw: raw, verifiedRaw: raw.nullable(), note: text(1000).nullable() })).max(500),
    retention: z
      .object({
        optionalGasBuffer: z.boolean(),
        perChainExtraRetainRaw: z.array(z.object({ chainId: chainIdSchema, amountRaw: raw, enabled: z.boolean() })).max(50),
      })
      .nullable(),
  }),
  currentState: z
    .object({
      label: z.literal("Live re-read at export time. Not part of the historical record."),
      chains: z.array(currentChainSchema).max(50),
    })
    .nullable(),
});
export type ReceiptBody = z.infer<typeof receiptBodySchema>;

export const receiptSchema = receiptBodySchema.extend({
  integrity: z.object({ algorithm: z.literal(RECEIPT_HASH_ALGORITHM), hash: bytes32Schema }),
});
export type Receipt = z.infer<typeof receiptSchema>;

/* -------------------------------------------------------------------------- */
/*                                   Building                                 */
/* -------------------------------------------------------------------------- */

export interface LiveObservation {
  observedAt: number;
  inspection: SafeInspection | null;
  issues: string[];
  safeHoldings: NetworkDiscovery | null;
  remaining: NetworkDiscovery | null;
  error: string | null;
}

const nul = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
/** Long free text (errors, reasons) is truncated so a receipt always fits its schema. */
const cut = (s: string | null | undefined, n: number): string | null => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lowerHex = (h: string | null | undefined) => (h ? (h.toLowerCase() as Hex) : null);

function scopeAssetIntent(a: import("@/lib/domain/types").ScopeAsset) {
  const t = a.transferIntent;
  return {
    assetId: a.assetId,
    chainId: a.chainId,
    label: cut(a.label, 200)!,
    amountRaw: a.amount,
    decimals: a.decimals,
    intentMode: t?.mode ?? null,
    requestedRaw: t?.mode === "exact" ? t.amount : t?.mode === "max" ? t.ceiling : null,
  };
}

function displayAmount(a: MigrationAction, amounts: readonly string[]): string {
  if (a.kind === "deploy_safe") return "";
  if (a.kind === "transfer_erc721") return `#${a.tokenIds[0] ?? "?"}`;
  if (a.kind === "transfer_erc1155") return a.tokenIds.map((id, i) => `#${id} x ${amounts[i] ?? "?"}`).join(", ");
  return `${formatAmount(amounts[0] ?? "0", a.decimals)} ${a.symbol}`.trim();
}

function intentFields(a: MigrationAction) {
  const t = a.transferIntent;
  if (!t) return { requestedRaw: null as string[] | null, intentMode: null as "exact" | "max" | null, reviewedCeilingRaw: null as string | null };
  if (t.mode === "exact") return { requestedRaw: [t.amount], intentMode: "exact" as const, reviewedCeilingRaw: null };
  return { requestedRaw: null, intentMode: "max" as const, reviewedCeilingRaw: t.ceiling };
}

function actionRecord(a: MigrationAction) {
  const v = a.verification;
  const intent = intentFields(a);
  return {
    id: a.id,
    kind: a.kind,
    label: cut(a.label, 200)!,
    status: a.status,
    contract: a.contract,
    tokenIds: [...a.tokenIds],
    symbol: a.symbol,
    decimals: a.decimals,
    amounts: {
      ...intent,
      reviewedRaw: a.previewAmounts ? [...a.previewAmounts] : null,
      plannedRaw: [...a.amounts],
      verifiedDeltaRaw: nul(v?.safeDelta),
      loggedRaw: nul(v?.loggedAmount),
      sourceRemainingRaw: nul(v?.sourceRemaining),
    },
    display: {
      planned: displayAmount(a, a.amounts),
      verified: v?.safeDelta && a.kind !== "deploy_safe" && a.kind !== "transfer_erc721" && a.kind !== "transfer_erc1155" ? `${formatAmount(v.safeDelta, a.decimals)} ${a.symbol}`.trim() : null,
    },
    txHash: lowerHex(a.txHash),
    callsId: a.callsId,
    feePaidRaw: a.feePaid,
    evidence: nul(v?.evidence),
    verificationBlock: nul(v?.blockNumber),
    note: cut(v?.note, 1000),
    error: a.error ? { code: a.error.code, message: cut(a.error.message, 1000)! } : null,
  };
}

function chainRecord(c: ChainMigration): ReceiptBody["record"]["chains"][number] {
  const meta = findChain(c.chainId);
  const deploy = c.actions.find((a) => a.kind === "deploy_safe");
  const how: ReceiptBody["record"]["chains"][number]["deployment"]["how"] = !deploy
    ? "unknown"
    : deploy.status === "verified" && deploy.txHash
      ? "deployed_in_this_run"
      : deploy.status === "skipped" || (deploy.status === "verified" && !deploy.txHash)
        ? "already_deployed"
        : "not_completed";
  const fees = c.actions.filter((a) => a.txHash || a.callsId);
  const insp = c.safeVerification;
  return {
    chainId: c.chainId,
    network: meta?.name ?? String(c.chainId),
    nativeSymbol: meta?.nativeSymbol ?? "",
    nativeDecimals: meta?.nativeDecimals ?? 18,
    safeAddress: c.safeAddress,
    safeVersion: c.safeVersion,
    strategy: c.strategy,
    outcome: chainOutcome(c),
    deployment: { how, txHash: lowerHex(deploy?.txHash) },
    verifiedAtMigration: insp?.isSafe
      ? {
          blockNumber: insp.blockNumber,
          blockHash: lowerHex(insp.blockHash),
          owners: [...insp.owners],
          threshold: insp.threshold,
          singleton: insp.singleton,
          fallbackHandler: insp.fallbackHandler,
          guard: insp.guard,
          modules: [...insp.modules],
        }
      : null,
    reviewedGovernance: c.expectedGovernance ? { owners: [...c.expectedGovernance.owners], threshold: c.expectedGovernance.threshold, observedAtBlock: c.expectedGovernance.observedAtBlock } : null,
    actions: c.actions.map(actionRecord),
    batches: c.batches.map((b) => ({
      callsId: b.callsId,
      state: b.state ?? "unknown",
      statusCode: b.statusCode,
      atomic: b.atomic,
      transactionHashes: b.transactionHashes.map((h) => h.toLowerCase() as Hex),
      actionIds: [...b.actionIds],
      submittedAt: b.submittedAt,
    })),
    fees: {
      paidRaw: fees.reduce((s, a) => s + toBigInt(a.feePaid), 0n).toString(),
      actionsWithUnknownFee: fees.filter((a) => a.feePaid === null).length,
    },
  };
}

function verificationMethod(m: Migration): "owner-ack-v2" | "legacy-v1" | "mixed" | "none" {
  const proofs = m.ownerProofs ?? [];
  if (proofs.length === 0) return "none";
  const v2 = proofs.filter((p) => p.verification.schema === "owner-ack-v2").length;
  return v2 === proofs.length ? "owner-ack-v2" : v2 === 0 ? "legacy-v1" : "mixed";
}

/**
 * Builds the receipt body from a migration record and, optionally, a live re-read. Pure: the same
 * inputs give the same body. Private labels, owner signatures and the debug log are never included.
 */
export function buildReceiptBody(params: {
  migration: Migration;
  generatedAt: number;
  app?: { version: string | null; commit: string | null };
  live?: Record<number, LiveObservation> | null;
}): ReceiptBody {
  const m = params.migration;
  const summary = migrationOutcome(m);
  const scope = m.scope ?? null;
  const discrepancies = m.chains.flatMap((c) =>
    c.actions
      .filter((a) => a.status === "verified_with_discrepancy")
      .map((a) => ({
        chainId: c.chainId,
        actionId: a.id,
        label: cut(a.label, 200)!,
        expectedRaw: a.verification?.expected ?? a.amounts[0] ?? "0",
        verifiedRaw: nul(a.verification?.safeDelta),
        note: cut(a.verification?.note, 1000),
      })),
  );
  const live = params.live ?? null;
  return {
    kind: RECEIPT_KIND,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    app: { name: "Safe Migrator", version: params.app?.version || null, commit: params.app?.commit || null },
    record: {
      migrationId: m.id,
      profileId: m.profileId ?? null,
      purpose: m.purpose ?? "unknown",
      createdAt: m.createdAt,
      lastUpdatedAt: m.updatedAt,
      runState: m.runState,
      outcome: summary.outcome,
      outcomeScope: summary.scopeKnown
        ? "Outcome covers the assets selected for this run on the selected networks. It does not mean the source wallet is empty or retired."
        : "Outcome covers the executed steps only; this record predates scope tracking, so the original selection is unknown. It does not mean the source wallet is empty or retired.",
      source: m.source,
      environment: m.environment,
      destination: {
        deploymentCommitment: lowerHex(m.deploymentCommitment),
        owners: [...m.safeConfig.owners],
        threshold: m.safeConfig.threshold,
        saltNonce: m.safeConfig.saltNonce,
      },
      ownerVerification: {
        verifiedOwners: (m.ownerProofs ?? []).map((p) => p.owner),
        method: verificationMethod(m),
        waivedOnTestnet: m.environment === "testnet" && (m.ownerProofs ?? []).length < m.safeConfig.threshold,
      },
      scope: scope
        ? {
            selectedChainIds: [...scope.selectedChainIds],
            includedChainIds: [...scope.includedChainIds],
            blockedChains: scope.blockedChains.map((b) => ({ chainId: b.chainId, reasons: b.reasons.slice(0, 20).map((r) => cut(r, 1000)!) })),
            excludedAssets: scope.excludedAssets.map((a) => ({ ...scopeAssetIntent(a), reason: cut(a.reason, 1000) })),
            selectedAssets: scope.selectedAssets.map((a) => scopeAssetIntent(a)),
            partialAcknowledged: scope.partialAcknowledged,
            incompleteDiscovery: scope.incompleteDiscovery.map((d) => ({ chainId: d.chainId, note: cut(d.note, 1000)! })),
            plannedAt: scope.plannedAt,
          }
        : null,
      chains: m.chains.map(chainRecord),
      discrepancies,
      retention: m.gasRetention
        ? {
            optionalGasBuffer: Object.values(m.gasRetention.perChain).some((c) => c.enabled),
            perChainExtraRetainRaw: Object.entries(m.gasRetention.perChain).map(([chainId, c]) => ({
              chainId: Number(chainId),
              amountRaw: c.extraRetainRaw,
              enabled: c.enabled,
            })),
          }
        : null,
    },
    currentState: live
      ? {
          label: "Live re-read at export time. Not part of the historical record.",
          chains: m.chains.map((c) => {
            const o = live[c.chainId];
            if (!o) return { chainId: c.chainId, observedAt: params.generatedAt, blockNumber: null, safe: null, safeHoldings: null, remainingInSource: null, error: "Not re-read." };
            return {
              chainId: c.chainId,
              observedAt: o.observedAt,
              blockNumber: o.inspection?.blockNumber ?? null,
              safe: o.inspection ? { isSafe: o.inspection.isSafe, owners: [...o.inspection.owners], threshold: o.inspection.threshold, issues: o.issues.slice(0, 20).map((i) => cut(i, 500)!) } : null,
              safeHoldings: o.safeHoldings ? o.safeHoldings.assets.map((x) => ({ assetId: x.id, symbol: x.symbol.slice(0, 40), balanceRaw: x.balance, decimals: x.decimals })) : null,
              remainingInSource: o.remaining
                ? o.remaining.assets.map((x) => ({ assetId: x.id, symbol: x.symbol.slice(0, 40), balanceRaw: x.balance, decimals: x.decimals, classification: x.classification }))
                : null,
              error: o.error ? o.error.slice(0, 500) : null,
            };
          }),
        }
      : null,
  };
}

export function sealReceipt(body: ReceiptBody): Receipt {
  const parsed = receiptBodySchema.parse(body);
  return { ...parsed, integrity: { algorithm: RECEIPT_HASH_ALGORITHM, hash: receiptHash(parsed) } };
}

export function buildReceipt(params: Parameters<typeof buildReceiptBody>[0]): Receipt {
  return sealReceipt(buildReceiptBody(params));
}

/** Pretty JSON for files; the hash is over the canonical form, so whitespace does not matter. */
export function receiptToJson(r: Receipt): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/*                                  Inspection                                */
/* -------------------------------------------------------------------------- */

export type InspectResult =
  | { ok: true; receipt: Receipt; hashMatches: boolean; recomputed: Hex }
  | { ok: false; reason: string };

/**
 * Validates a receipt file offline: size, JSON, schema (addresses, chain IDs, enums, amounts) and
 * the integrity hash. Nothing in the file is fetched or executed.
 */
export function inspectReceipt(text: string): InspectResult {
  if (new TextEncoder().encode(text).length > RECEIPT_MAX_BYTES) return { ok: false, reason: "File is too large to be a receipt." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "File is not valid JSON." };
  }
  const parsed = receiptSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `Not a valid v${RECEIPT_SCHEMA_VERSION} receipt: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "schema mismatch"}.` };
  }
  // Hash the file's own bytes-as-JSON, not the schema-normalized copy: any edit, including an
  // added field or a changed letter case, must change the hash.
  const { integrity: _integrity, ...originalBody } = json as Record<string, unknown>;
  void _integrity;
  let recomputed: Hex;
  try {
    recomputed = receiptHash(originalBody);
  } catch (e) {
    return { ok: false, reason: `Receipt cannot be canonicalized: ${(e as Error).message}` };
  }
  return { ok: true, receipt: parsed.data, hashMatches: recomputed === parsed.data.integrity.hash.toLowerCase(), recomputed };
}

/** Human summary line that never overstates an incomplete run. */
export function outcomeHeadline(r: ReceiptBody): { title: string; tone: "success" | "warning" | "danger" } {
  switch (r.record.outcome) {
    case "complete":
      return { title: "Selected assets migrated and verified", tone: "success" };
    case "partial":
      return { title: "PARTIAL: part of the selection did not migrate", tone: "warning" };
    case "uncertain":
      return { title: "UNCERTAIN: at least one step has an unknown outcome", tone: "danger" };
    default:
      return { title: "INCOMPLETE: some steps did not finish", tone: "danger" };
  }
}
