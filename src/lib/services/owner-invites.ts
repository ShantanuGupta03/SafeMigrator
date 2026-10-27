import { bytesToHex, encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { proxyFactoryAbi } from "@/lib/abis";
import { chainsForEnvironment, findChain } from "@/lib/chains/registry";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  environmentSchema,
  hexSchema,
  idSchema,
  RECIPE_DERIVATION,
  safeVersionSchema,
  timestampSchema,
  uintStringSchema,
  type SafeProfile,
} from "@/lib/domain/profile";
import type { OwnerVerification, SafeConfig } from "@/lib/domain/types";
import { canonicalContractSet, computeSafeAddress, encodeSetupInitializer, verifyCanonicalContracts } from "./safe-deployment";
import { isPinned, recipeCommitment } from "./safe-profile";
import { buildSafeConfig, safeConfigHash } from "./signer-configuration";

/*
 * Remote co-owner verification (EIP-712 "owner acknowledgement", schema v2).
 *
 * Signed facts, split by purpose:
 *  - Configuration identity: `safe`, `owners`, `threshold` and `deploymentCommitment` (which binds the
 *    pinned recipe: version, contracts, exact initializer, salt and proxy creation code hash).
 *  - This invitation's scope: `source`, `profileId`, `environment`, `targetChainIds` (+ their
 *    `scopeCommitment`), a random `nonce`, `issuedAt` and `expiresAt`.
 * The domain has no `verifyingContract`; its `chainId` is the network the owner signed on, which is
 * also where a contract-wallet (ERC-1271) signature is checked.
 *
 * The signature acknowledges ownership only. It authorizes no transaction and is never used as one.
 */

export const ACK_DOMAIN_NAME = "Safe Migrator Owner Verification";
export const ACK_DOMAIN_VERSION = "2";
export const ACK_STATEMENT =
  "I control this address and acknowledge it as an owner of the Safe identified by deploymentCommitment. This signature authorizes no transaction and moves no funds.";

export const ACK_TYPES = {
  OwnerAcknowledgement: [
    { name: "owner", type: "address" },
    { name: "safe", type: "address" },
    { name: "owners", type: "address[]" },
    { name: "threshold", type: "uint256" },
    { name: "deploymentCommitment", type: "bytes32" },
    { name: "source", type: "address" },
    { name: "profileId", type: "string" },
    { name: "environment", type: "string" },
    { name: "targetChainIds", type: "uint256[]" },
    { name: "scopeCommitment", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
  ],
} as const;

/** Defaults and bounds. Invitation lifetime and accepted-proof lifetime are separate on purpose. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const INVITE_TTL_CHOICES_MS = [60 * 60 * 1000, INVITE_TTL_MS, 72 * 60 * 60 * 1000] as const;
export const INVITE_MAX_TTL_MS = 72 * 60 * 60 * 1000;
/** A response must be imported before the invitation expires; an imported proof is accepted for execution for 7 days after issuance. */
export const ACCEPTED_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock skew between the two devices. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const INVITE_MAX_FRAGMENT_CHARS = 6000;
export const RESPONSE_MAX_BYTES = 16 * 1024;

/* -------------------------------------------------------------------------- */
/*                                   Payloads                                 */
/* -------------------------------------------------------------------------- */

const ms = timestampSchema.refine((v) => v % 1000 === 0, "Timestamps are whole seconds");

/** What an invitation link carries. Everything is public configuration; there are no secrets. */
export const invitePayloadSchema = z.object({
  v: z.literal(1),
  k: z.literal("owner-invite"),
  owner: addressSchema,
  source: addressSchema,
  environment: environmentSchema,
  profileId: idSchema,
  owners: z.array(addressSchema).min(1).max(10),
  threshold: z.number().int().min(1).max(10),
  saltNonce: uintStringSchema,
  recipe: z.object({
    derivation: z.literal(RECIPE_DERIVATION),
    safeVersion: safeVersionSchema,
    factory: addressSchema,
    singleton: addressSchema,
    fallbackHandler: addressSchema,
    proxyCreationCodeHash: bytes32Schema,
  }),
  safe: addressSchema,
  commitment: bytes32Schema,
  chainIds: z.array(chainIdSchema).min(1).max(20),
  nonce: bytes32Schema,
  issuedAt: ms,
  expiresAt: ms,
});
export type InvitePayload = z.infer<typeof invitePayloadSchema>;

export const inviteResponseSchema = z.object({
  v: z.literal(1),
  k: z.literal("owner-invite-response"),
  invite: invitePayloadSchema,
  chainId: chainIdSchema,
  signature: hexSchema(4096),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

export const ownerInviteSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  owner: addressSchema,
  commitment: bytes32Schema,
  scopeCommitment: bytes32Schema,
  chainIds: z.array(chainIdSchema).min(1).max(20),
  nonce: bytes32Schema,
  issuedAt: ms,
  expiresAt: ms,
  createdAt: timestampSchema,
  status: z.enum(["pending", "verified", "revoked"]),
  proof: z
    .object({
      signature: hexSchema(4096),
      chainId: chainIdSchema,
      signerType: z.enum(["eoa", "contract"]),
      verifiedAt: timestampSchema,
    })
    .nullable(),
});
export type OwnerInvite = z.infer<typeof ownerInviteSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

export function scopeCommitment(chainIds: readonly number[]): Hex {
  const sorted = [...new Set(chainIds)].sort((a, b) => a - b);
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256[]" }], ["safe-migrator/target-scope/v1", sorted.map(BigInt)]));
}

const sortedIds = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function payloadFor(profile: SafeProfile, invite: OwnerInvite): InvitePayload {
  if (!isPinned(profile)) throw new Error("Owner invitations need a saved Safe with a pinned recipe.");
  return {
    v: 1,
    k: "owner-invite",
    owner: invite.owner,
    source: profile.source,
    environment: profile.environment,
    profileId: profile.id,
    owners: profile.original.owners,
    threshold: profile.original.threshold,
    saltNonce: profile.original.saltNonce,
    recipe: {
      derivation: profile.recipe.derivation,
      safeVersion: profile.recipe.safeVersion,
      factory: profile.recipe.factory,
      singleton: profile.recipe.singleton,
      fallbackHandler: profile.recipe.fallbackHandler,
      proxyCreationCodeHash: profile.recipe.proxyCreationCodeHash,
    },
    safe: profile.safeAddress,
    commitment: profile.commitment,
    chainIds: invite.chainIds,
    nonce: invite.nonce,
    issuedAt: invite.issuedAt,
    expiresAt: invite.expiresAt,
  };
}

/** The invitation fields that enter the signature (the recipe enters through `commitment`). */
export type AckFields = Pick<InvitePayload, "owner" | "safe" | "owners" | "threshold" | "commitment" | "source" | "profileId" | "environment" | "chainIds" | "nonce" | "issuedAt" | "expiresAt">;

/** EIP-712 typed data for an invitation, signed on `chainId`. */
export function acknowledgementTypedData(p: AckFields, chainId: number) {
  return {
    domain: { name: ACK_DOMAIN_NAME, version: ACK_DOMAIN_VERSION, chainId },
    types: ACK_TYPES,
    primaryType: "OwnerAcknowledgement" as const,
    message: {
      owner: p.owner,
      safe: p.safe,
      owners: p.owners,
      threshold: BigInt(p.threshold),
      deploymentCommitment: p.commitment,
      source: p.source,
      profileId: p.profileId,
      environment: p.environment,
      targetChainIds: sortedIds(p.chainIds).map(BigInt),
      scopeCommitment: scopeCommitment(p.chainIds),
      nonce: p.nonce,
      issuedAt: BigInt(p.issuedAt / 1000),
      expiresAt: BigInt(p.expiresAt / 1000),
      statement: ACK_STATEMENT,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               Initiator side                               */
/* -------------------------------------------------------------------------- */

export function createInvite(params: { profile: SafeProfile; owner: Address; chainIds: readonly number[]; ttlMs?: number; now?: number }): OwnerInvite {
  const { profile } = params;
  if (!isPinned(profile)) throw new Error("Pin the Safe configuration before inviting owners.");
  const owner = getAddress(params.owner);
  if (!profile.original.owners.includes(owner)) throw new Error("This address is not an owner of the saved configuration.");
  const env = new Set(chainsForEnvironment(profile.environment).map((c) => c.id));
  const chainIds = sortedIds(params.chainIds);
  if (chainIds.length === 0 || chainIds.some((id) => !env.has(id))) throw new Error("Invitation networks must belong to the Safe's environment.");
  const ttl = params.ttlMs ?? INVITE_TTL_MS;
  if (ttl <= 0 || ttl > INVITE_MAX_TTL_MS) throw new Error("Invitation lifetime must be between 1 second and 72 hours.");
  const issuedAt = Math.floor((params.now ?? Date.now()) / 1000) * 1000;
  return {
    id: crypto.randomUUID(),
    profileId: profile.id,
    owner,
    commitment: profile.commitment,
    scopeCommitment: scopeCommitment(chainIds),
    chainIds,
    nonce: randomNonce(),
    issuedAt,
    expiresAt: issuedAt + Math.floor(ttl / 1000) * 1000,
    createdAt: params.now ?? Date.now(),
    status: "pending",
    proof: null,
  };
}

export type InviteState = "verified" | "awaiting" | "expired" | "revoked" | "invalidated";

/**
 * Status as shown to the initiator. A configuration edit (different commitment) or an owner that is
 * no longer in the configuration invalidates both pending invitations and their proofs.
 */
export function inviteState(invite: OwnerInvite, profile: SafeProfile | null, now = Date.now()): InviteState {
  if (invite.status === "revoked") return "revoked";
  if (!profile || !isPinned(profile) || profile.id !== invite.profileId || profile.commitment !== invite.commitment || !profile.original.owners.includes(invite.owner)) {
    return "invalidated";
  }
  if (invite.status === "verified") return now - invite.issuedAt > ACCEPTED_PROOF_MAX_AGE_MS ? "expired" : "verified";
  return now > invite.expiresAt ? "expired" : "awaiting";
}

export type ImportResult =
  | { ok: true; invite: OwnerInvite; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Validates a co-owner's signed response against the invitation THIS workspace issued. The nonce is
 * consumed (the invitation becomes `verified`) only after every check passes. Importing the same
 * response again is a no-op; nonce tracking is local to this browser's stored workspace and is not
 * a global replay registry.
 */
export async function importInviteResponse(params: {
  text: string;
  invites: readonly OwnerInvite[];
  profile: SafeProfile | null;
  clientFor: (chainId: number) => PublicClient;
  now?: number;
}): Promise<ImportResult> {
  const now = params.now ?? Date.now();
  if (new TextEncoder().encode(params.text).length > RESPONSE_MAX_BYTES) return { ok: false, reason: "Response is too large." };
  let json: unknown;
  try {
    json = JSON.parse(params.text.trim());
  } catch {
    return { ok: false, reason: "Response is not valid JSON." };
  }
  const parsed = inviteResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "Not a Safe Migrator owner response." };
  const r = parsed.data;
  const invite = params.invites.find((i) => i.nonce === r.invite.nonce);
  if (!invite) return { ok: false, reason: "This response answers an invitation that this workspace did not issue. It was not accepted." };
  if (invite.status === "revoked") return { ok: false, reason: "This invitation was revoked." };
  if (invite.status === "verified") {
    return invite.proof?.signature.toLowerCase() === r.signature.toLowerCase()
      ? { ok: true, invite, duplicate: true }
      : { ok: false, reason: "This invitation was already answered with a different signature." };
  }
  const profile = params.profile;
  if (!profile || !isPinned(profile) || profile.id !== invite.profileId) return { ok: false, reason: "The saved Safe this invitation belongs to is not selected." };
  if (profile.commitment !== invite.commitment || !profile.original.owners.includes(invite.owner)) {
    return { ok: false, reason: "The Safe configuration changed after this invitation was created. Create a new invitation." };
  }
  if (now > invite.expiresAt) return { ok: false, reason: "The invitation expired before its response was imported. Create a new invitation." };

  // The response must echo exactly what was issued, recomputed from local records, not from the file.
  const expected = payloadFor(profile, invite);
  if (canonicalPayload(r.invite) !== canonicalPayload(expected)) {
    return { ok: false, reason: "The response does not match the invitation that was issued (altered owner, Safe, networks, times or nonce)." };
  }
  if (!invite.chainIds.includes(r.chainId)) return { ok: false, reason: "The response was signed for a network outside the invitation." };

  const client = params.clientFor(r.chainId);
  let valid = false;
  try {
    if ((await client.getChainId()) !== r.chainId) return { ok: false, reason: "Verification client is on the wrong network." };
    // viem verifies EOAs by ecrecover and contract wallets via ERC-1271 / ERC-6492 on this chain.
    valid = await client.verifyTypedData({ address: invite.owner, signature: r.signature, ...acknowledgementTypedData(expected, r.chainId) });
  } catch (e) {
    return { ok: false, reason: `Signature could not be checked: ${(e as Error).message.slice(0, 160)}` };
  }
  if (!valid) return { ok: false, reason: "The signature was not made by the invited owner for this exact invitation." };
  const signerType = await signerTypeOf(client, invite.owner);
  return { ok: true, duplicate: false, invite: { ...invite, status: "verified", proof: { signature: r.signature, chainId: r.chainId, signerType, verifiedAt: now } } };
}

async function signerTypeOf(client: PublicClient, owner: Address): Promise<"eoa" | "contract"> {
  const code = await client.getCode({ address: owner }).catch(() => undefined);
  return !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100") ? "contract" : "eoa";
}

function canonicalPayload(p: InvitePayload): string {
  return JSON.stringify({ ...p, chainIds: sortedIds(p.chainIds), owners: p.owners.map((o) => o.toLowerCase()) }, (_k, v) => (typeof v === "string" ? v.toLowerCase() : v));
}

/** The draft-level verification record for an accepted invitation (re-verified at execution). */
export function verificationFromInvite(invite: OwnerInvite, profile: SafeProfile): OwnerVerification {
  if (invite.status !== "verified" || !invite.proof || !isPinned(profile)) throw new Error("Invitation is not verified.");
  return {
    method: "eip712",
    schema: "owner-ack-v2",
    signature: invite.proof.signature,
    nonce: invite.nonce,
    issuedAt: invite.issuedAt,
    expiresAt: invite.expiresAt,
    configHash: safeConfigHash(profile.original),
    deploymentCommitment: invite.commitment,
    scopeChainIds: invite.chainIds,
    safeAddress: profile.safeAddress,
    profileId: profile.id,
    source: profile.source,
    environment: profile.environment,
    verifiedAt: invite.proof.verifiedAt,
    signerType: invite.proof.signerType,
    chainId: invite.proof.chainId,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Re-verification (execution)                         */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds the exact signed acknowledgement from a stored v2 verification and the configuration it
 * claims, then checks the signature again with a client for the proof's OWN network.
 */
export async function reverifyAcknowledgement(params: {
  owner: Address;
  verification: OwnerVerification;
  config: SafeConfig;
  deploymentCommitment: Hex;
  clientFor: (chainId: number) => PublicClient;
  now?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const v = params.verification;
  const now = params.now ?? Date.now();
  if (v.schema !== "owner-ack-v2" || !v.deploymentCommitment || !v.scopeChainIds || !v.safeAddress || !v.profileId || !v.source || !v.environment || !v.expiresAt) {
    return { ok: false, reason: "Not a v2 owner acknowledgement." };
  }
  if (v.deploymentCommitment.toLowerCase() !== params.deploymentCommitment.toLowerCase()) return { ok: false, reason: "Signed for a different deployment commitment." };
  if (v.issuedAt > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "Issued in the future." };
  if (now - v.issuedAt > ACCEPTED_PROOF_MAX_AGE_MS) return { ok: false, reason: "Owner proof is older than 7 days; verify again." };
  if (!findChain(v.chainId)) return { ok: false, reason: "Proof signed on an unsupported network." };
  const fields: AckFields = {
    owner: getAddress(params.owner),
    source: v.source,
    environment: v.environment,
    profileId: v.profileId,
    owners: params.config.owners,
    threshold: params.config.threshold,
    safe: v.safeAddress,
    commitment: params.deploymentCommitment,
    chainIds: v.scopeChainIds,
    nonce: v.nonce,
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
  };
  const client = params.clientFor(v.chainId);
  try {
    if ((await client.getChainId()) !== v.chainId) return { ok: false, reason: "Verification client is on the wrong network." };
    const valid = await client.verifyTypedData({ address: params.owner, signature: v.signature, ...acknowledgementTypedData(fields, v.chainId) });
    return valid ? { ok: true } : { ok: false, reason: "Signature does not match this owner and configuration." };
  } catch (e) {
    return { ok: false, reason: `Signature check failed: ${(e as Error).message.slice(0, 160)}` };
  }
}

/* -------------------------------------------------------------------------- */
/*                                Co-owner side                               */
/* -------------------------------------------------------------------------- */

export type InviteCheck =
  | { ok: true; payload: InvitePayload; config: SafeConfig; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Offline checks a co-owner's device runs on an invitation before showing the sign button. Labels
 * and addresses in the link are never trusted: the commitment is recomputed from the configuration
 * and recipe. The address check needs the factory's creation code (`verifyInviteAddress`).
 */
export function checkInvitePayload(raw: unknown, now = Date.now()): InviteCheck {
  const parsed = invitePayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "This is not a valid Safe Migrator invitation." };
  const p = parsed.data;
  if (p.issuedAt > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "The invitation claims to be issued in the future. Check both devices' clocks and ask for a new link." };
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > INVITE_MAX_TTL_MS) return { ok: false, reason: "The invitation has an invalid lifetime." };
  if (now > p.expiresAt) return { ok: false, reason: `The invitation expired on ${new Date(p.expiresAt).toLocaleString()}. Ask for a new link.` };
  let config: SafeConfig;
  try {
    config = buildSafeConfig(p.owners, p.threshold, p.saltNonce);
  } catch (e) {
    return { ok: false, reason: `Invalid owner configuration: ${(e as Error).message}.` };
  }
  if (config.owners.some((o, i) => o !== p.owners[i])) return { ok: false, reason: "Owners are not in canonical order." };
  if (!config.owners.includes(p.owner)) return { ok: false, reason: "The invited address is not one of the owners." };
  const env = new Set(chainsForEnvironment(p.environment).map((c) => c.id));
  if (p.chainIds.some((id) => !env.has(id))) return { ok: false, reason: "The invitation lists networks outside its environment." };
  const canonical = canonicalContractSet(p.recipe.safeVersion);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(p.recipe.factory, canonical.proxyFactory) || !eq(p.recipe.singleton, canonical.singleton) || !eq(p.recipe.fallbackHandler, canonical.fallbackHandler)) {
    return { ok: false, reason: "The invitation does not use the official Safe contracts for its version." };
  }
  const recomputed = recipeCommitment({
    derivation: p.recipe.derivation,
    safeVersion: p.recipe.safeVersion,
    singletonVariant: "l2",
    factory: p.recipe.factory,
    singleton: p.recipe.singleton,
    fallbackHandler: p.recipe.fallbackHandler,
    initializer: encodeSetupInitializer(config, p.recipe.fallbackHandler),
    saltNonce: config.saltNonce,
    proxyCreationCodeHash: p.recipe.proxyCreationCodeHash,
  });
  if (recomputed !== p.commitment) return { ok: false, reason: "The deployment commitment does not match the listed owners, threshold and recipe." };
  const warnings: string[] = [];
  if (p.threshold === 1 && p.owners.length > 1) warnings.push("Any single owner can move everything in this Safe.");
  if (p.threshold === p.owners.length && p.owners.length > 1) warnings.push("Every owner must sign; one lost key locks the Safe.");
  return { ok: true, payload: p, config, warnings };
}

/**
 * Recomputes the Safe address from the official factory's creation code on one of the invitation's
 * networks. Returns `unavailable` when the network cannot be read, which is not a mismatch.
 */
export async function verifyInviteAddress(p: InvitePayload, config: SafeConfig, clientFor: (chainId: number) => PublicClient): Promise<{ status: "match" | "mismatch" | "unavailable"; chainId: number | null; detail: string }> {
  let lastError = "";
  for (const chainId of p.chainIds) {
    try {
      const client = clientFor(chainId);
      if ((await client.getChainId()) !== chainId) throw new Error("wrong network");
      const check = await verifyCanonicalContracts(client, p.recipe.safeVersion);
      if (!check.ok) return { status: "mismatch", chainId, detail: check.issues.join(" ") };
      const code = await client.readContract({ address: p.recipe.factory, abi: proxyFactoryAbi, functionName: "proxyCreationCode" });
      if (keccak256(code).toLowerCase() !== p.recipe.proxyCreationCodeHash.toLowerCase()) return { status: "mismatch", chainId, detail: "Factory creation code differs from the invitation." };
      const address = computeSafeAddress({
        factory: p.recipe.factory,
        singleton: p.recipe.singleton,
        initializer: encodeSetupInitializer(config, p.recipe.fallbackHandler),
        saltNonce: BigInt(config.saltNonce),
        proxyCreationCode: code,
      });
      return address === p.safe
        ? { status: "match", chainId, detail: `Recomputed on ${findChain(chainId)?.name ?? chainId}.` }
        : { status: "mismatch", chainId, detail: `The configuration produces ${address}, not ${p.safe}.` };
    } catch (e) {
      lastError = (e as Error).message.slice(0, 120);
    }
  }
  return { status: "unavailable", chainId: null, detail: `Could not reach any listed network to recompute the address: ${lastError}` };
}

export function buildResponse(p: InvitePayload, chainId: number, signature: Hex): string {
  const response: InviteResponse = { v: 1, k: "owner-invite-response", invite: p, chainId, signature };
  return JSON.stringify(response, null, 2);
}

/* -------------------------------------------------------------------------- */
/*                             Link / file encoding                           */
/* -------------------------------------------------------------------------- */

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  const reader = out.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) throw new Error("Payload too large.");
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  return merged;
}

/** `#i=<base64url(deflate-raw(json))>` — the fragment never reaches a server or a Referer header. */
export async function encodeInviteFragment(p: InvitePayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(p));
  return `i=${toBase64Url(await pipe(json, new CompressionStream("deflate-raw"), 64 * 1024))}`;
}

export async function decodeInviteFragment(fragment: string): Promise<unknown> {
  const raw = fragment.replace(/^#/, "");
  if (raw.length > INVITE_MAX_FRAGMENT_CHARS) throw new Error("Invitation link is too long.");
  const params = new URLSearchParams(raw);
  const data = params.get("i");
  if (!data || !/^[A-Za-z0-9_-]+$/.test(data)) throw new Error("No invitation found in this link.");
  const bytes = await pipe(fromBase64Url(data), new DecompressionStream("deflate-raw"), 32 * 1024);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Downloadable alternative to the link, for payloads too large for a practical QR code. */
export function inviteFile(p: InvitePayload): string {
  return JSON.stringify(p, null, 2);
}

/** Above this many characters a QR code becomes impractical to scan with a phone. */
export const QR_PRACTICAL_MAX_CHARS = 1800;
