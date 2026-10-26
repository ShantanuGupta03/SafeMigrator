import type { Address, Hex, PublicClient } from "viem";
import { getAddress } from "viem";
import type { Migration, OwnerProof, SafeConfig, SignerSlot } from "@/lib/domain/types";
import { executionGate } from "@/lib/chains/registry";
import { verifyStoredOwnerProof, type OwnerChallenge } from "./ownership-verification";
import { safeConfigHash } from "./signer-configuration";

const EXECUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface OwnerReadiness {
  ok: boolean;
  proofs: OwnerProof[];
  verifiedOwners: Address[];
  issues: string[];
  waived: boolean;
}

/** Cryptographically re-validates owner proofs at execution time. Never trusts localStorage alone. */
export async function validateOwnerReadiness(params: {
  config: SafeConfig;
  signers: readonly SignerSlot[];
  usedNonces?: readonly string[];
  client: PublicClient;
  chainId: number;
  environment: Migration["environment"];
  waived?: boolean;
  now?: number;
}): Promise<OwnerReadiness> {
  const now = params.now ?? Date.now();
  const configHash = safeConfigHash(params.config);
  const ownerSet = new Set(params.config.owners.map((o) => o.toLowerCase()));
  const proofs: OwnerProof[] = [];
  const issues: string[] = [];
  for (const slot of params.signers) {
    const v = slot.verification;
    if (!v || !slot.address) continue;
    if (v.configHash !== configHash) {
      issues.push(`${slot.label || slot.address}: verification was for a different Safe configuration.`);
      continue;
    }
    if (!ownerSet.has(slot.address.toLowerCase())) {
      issues.push(`${slot.label || slot.address}: not an owner of this configuration.`);
      continue;
    }
    if (now - v.verifiedAt > EXECUTION_MAX_AGE_MS) {
      issues.push(`${slot.label || slot.address}: verification is older than 24 hours; verify again.`);
      continue;
    }
    const challenge: OwnerChallenge = {
      owner: getAddress(slot.address),
      configHash: v.configHash as Hex,
      nonce: v.nonce as Hex,
      issuedAt: v.issuedAt,
      chainId: v.chainId,
    };
    const check = await verifyStoredOwnerProof({ challenge, signature: v.signature as Hex, client: params.client, now });
    if (!check.ok) {
      issues.push(`${slot.label || slot.address}: ${check.reason}`);
      continue;
    }
    proofs.push({ owner: getAddress(slot.address), verification: check.verification });
  }

  const verifiedOwners = proofs.map((p) => p.owner);
  const gate = executionGate(params.chainId);
  const need = params.config.threshold;
  const waived = !!params.waived && params.environment === "testnet" && !gate.requiresVerifiedOwners;

  if (!waived && gate.requiresVerifiedOwners && verifiedOwners.length < need) {
    issues.push(`Production execution requires ${need} cryptographically verified owner${need === 1 ? "" : "s"}; ${verifiedOwners.length} validated.`);
  }

  const unique = new Set(verifiedOwners.map((o) => o.toLowerCase()));
  if (unique.size !== verifiedOwners.length) issues.push("Duplicate verified owners detected.");

  const testnetOk = params.environment === "testnet" && !gate.requiresVerifiedOwners && issues.length === 0;
  return { ok: issues.length === 0 || testnetOk || (waived && verifiedOwners.length === 0), proofs, verifiedOwners, issues, waived: waived || testnetOk };
}

/** Validates proofs persisted on the migration record (not the draft UI state). */
export async function validateMigrationOwnerProofs(
  m: Migration,
  client: PublicClient,
  chainId: number,
  now?: number,
): Promise<OwnerReadiness> {
  const signers: SignerSlot[] = (m.ownerProofs ?? []).map((p, i) => ({
    slot: i,
    input: p.owner,
    address: p.owner,
    ensName: null,
    kind: "independent_wallet",
    label: `Owner ${i + 1}`,
    verification: p.verification,
  }));
  return validateOwnerReadiness({
    config: m.safeConfig,
    signers,
    usedNonces: [],
    client,
    chainId,
    environment: m.environment,
    waived: m.ownerVerificationWaived,
    now,
  });
}
