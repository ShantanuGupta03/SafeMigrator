import type { Address, Hex, PublicClient } from "viem";
import { getAddress } from "viem";
import type { Migration, OwnerProof, SafeConfig, SignerSlot } from "@/lib/domain/types";
import { executionGate, findChain } from "@/lib/chains/registry";
import { reverifyAcknowledgement } from "./owner-invites";
import { verifyStoredOwnerProof, type OwnerChallenge } from "./ownership-verification";
import { safeConfigHash } from "./signer-configuration";

/** Legacy v1 challenges (pre-v1.5) stay valid for 24 hours after verification, as before. */
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface OwnerReadiness {
  ok: boolean;
  /** Proofs that verified cryptographically (on their own network). */
  proofs: OwnerProof[];
  /** Owners whose proof counts for the gated chain. */
  verifiedOwners: Address[];
  issues: string[];
  waived: boolean;
}

const nameOf = (chainId: number) => findChain(chainId)?.name ?? `chain ${chainId}`;

/**
 * Cryptographically re-validates owner proofs at execution time. Never trusts stored state alone.
 *
 * Each proof is checked with a client for the network its EIP-712 domain names, never with whatever
 * chain happens to execute first. An EOA proof establishes key control everywhere; a contract
 * wallet (ERC-1271) proof only says something about the network it was checked on, so it counts
 * only for that network.
 */
export async function validateOwnerReadiness(params: {
  config: SafeConfig;
  /** Pinned deployment commitment the run uses; required for v2 proofs. */
  deploymentCommitment: Hex | null;
  signers: readonly SignerSlot[];
  clientFor: (chainId: number) => PublicClient;
  /** The network whose execution is being gated. */
  chainId: number;
  environment: Migration["environment"];
  waived?: boolean;
  now?: number;
}): Promise<OwnerReadiness> {
  const now = params.now ?? Date.now();
  const configHash = safeConfigHash(params.config);
  const ownerSet = new Set(params.config.owners.map((o) => o.toLowerCase()));
  const proofs: OwnerProof[] = [];
  const counted: Address[] = [];
  const issues: string[] = [];
  for (const slot of params.signers) {
    const v = slot.verification;
    if (!v || !slot.address) continue;
    const who = slot.label || slot.address;
    if (v.configHash !== configHash) {
      issues.push(`${who}: verification was for a different Safe configuration.`);
      continue;
    }
    if (!ownerSet.has(slot.address.toLowerCase())) {
      issues.push(`${who}: not an owner of this configuration.`);
      continue;
    }
    if (v.schema === "owner-ack-v2") {
      if (!params.deploymentCommitment) {
        issues.push(`${who}: this run has no pinned deployment commitment to check the proof against.`);
        continue;
      }
      const r = await reverifyAcknowledgement({ owner: slot.address, verification: v, config: params.config, deploymentCommitment: params.deploymentCommitment, clientFor: params.clientFor, now });
      if (!r.ok) {
        issues.push(`${who}: ${r.reason}`);
        continue;
      }
    } else {
      if (now - v.verifiedAt > LEGACY_MAX_AGE_MS) {
        issues.push(`${who}: legacy verification is older than 24 hours; verify again.`);
        continue;
      }
      const challenge: OwnerChallenge = { owner: getAddress(slot.address), configHash: v.configHash as Hex, nonce: v.nonce as Hex, issuedAt: v.issuedAt, chainId: v.chainId };
      const r = await verifyStoredOwnerProof({ challenge, signature: v.signature as Hex, client: params.clientFor(v.chainId), now });
      if (!r.ok) {
        issues.push(`${who}: ${r.reason}`);
        continue;
      }
    }
    proofs.push({ owner: getAddress(slot.address), verification: v });
    if (v.signerType === "contract" && v.chainId !== params.chainId) {
      issues.push(`${who} is a contract wallet verified on ${nameOf(v.chainId)} only; its signing on ${nameOf(params.chainId)} is not established.`);
      continue;
    }
    counted.push(getAddress(slot.address));
  }

  const verifiedOwners = [...new Map(counted.map((o) => [o.toLowerCase(), o])).values()];
  if (verifiedOwners.length !== counted.length) issues.push("Duplicate verified owners were ignored.");
  const gate = executionGate(params.chainId);
  const need = params.config.threshold;
  if (gate.requiresVerifiedOwners) {
    const ok = verifiedOwners.length >= need;
    if (!ok) issues.push(`${nameOf(params.chainId)} requires ${need} cryptographically verified owner${need === 1 ? "" : "s"}; ${verifiedOwners.length} validated.`);
    return { ok, proofs, verifiedOwners, issues, waived: false };
  }
  // Testnets: owner verification is recommended, not required. Problems are reported, never blocking.
  return { ok: true, proofs, verifiedOwners, issues, waived: params.environment === "testnet" && (!!params.waived || verifiedOwners.length < need) };
}

/** Validates proofs persisted on the migration record (not the draft UI state) for one network. */
export async function validateMigrationOwnerProofs(
  m: Migration,
  clientFor: (chainId: number) => PublicClient,
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
    deploymentCommitment: m.deploymentCommitment ?? null,
    signers,
    clientFor,
    chainId,
    environment: m.environment,
    waived: m.ownerVerificationWaived,
    now,
  });
}
