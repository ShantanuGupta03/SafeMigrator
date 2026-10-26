import { bytesToHex, getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { OwnerVerification } from "@/lib/domain/types";

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const OWNER_CHALLENGE_TYPES = {
  OwnerChallenge: [
    { name: "owner", type: "address" },
    { name: "configHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "statement", type: "string" },
  ],
} as const;

export const CHALLENGE_STATEMENT =
  "I control this address and accept it as an owner of the Safe identified by configHash. This signature authorizes no transaction and moves no funds.";

export interface OwnerChallenge {
  owner: Address;
  configHash: Hex;
  nonce: Hex;
  issuedAt: number;
  chainId: number;
}

export function createChallenge(owner: Address, configHash: Hex, chainId: number, now = Date.now()): OwnerChallenge {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return { owner: getAddress(owner), configHash, nonce: bytesToHex(bytes), issuedAt: now, chainId };
}

/**
 * EIP-712 payload. No `verifyingContract`: the signature is bound to this app's domain, a single
 * Safe configuration, a random nonce and a timestamp, so it cannot be replayed as an onchain
 * authorization or reused for a different configuration.
 */
export function challengeTypedData(c: OwnerChallenge) {
  return {
    domain: { name: "Safe Migrator Owner Verification", version: "1", chainId: c.chainId },
    types: OWNER_CHALLENGE_TYPES,
    primaryType: "OwnerChallenge" as const,
    message: {
      owner: c.owner,
      configHash: c.configHash,
      nonce: c.nonce,
      issuedAt: BigInt(Math.floor(c.issuedAt / 1000)),
      statement: CHALLENGE_STATEMENT,
    },
  };
}

export type VerifyResult = { ok: true; verification: OwnerVerification } | { ok: false; reason: string };

export const EXECUTION_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Re-checks a stored proof at execution time (longer TTL, no one-time nonce gate). */
export async function verifyStoredOwnerProof(params: {
  challenge: OwnerChallenge;
  signature: Hex;
  client: PublicClient;
  maxAgeMs?: number;
  now?: number;
}): Promise<VerifyResult> {
  const now = params.now ?? Date.now();
  const maxAge = params.maxAgeMs ?? EXECUTION_PROOF_MAX_AGE_MS;
  if (now - params.challenge.issuedAt > maxAge) return { ok: false, reason: "Owner verification expired. Verify control again." };
  const clientChain = await params.client.getChainId();
  if (clientChain !== params.challenge.chainId) return { ok: false, reason: "Verification chain mismatch." };
  let valid = false;
  try {
    valid = await params.client.verifyTypedData({ address: params.challenge.owner, signature: params.signature, ...challengeTypedData(params.challenge) });
  } catch (e) {
    return { ok: false, reason: `Signature check failed: ${(e as Error).message.slice(0, 160)}` };
  }
  if (!valid) return { ok: false, reason: "Signature does not match this owner address." };
  const code = await params.client.getCode({ address: params.challenge.owner }).catch(() => undefined);
  const isContract = !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
  return {
    ok: true,
    verification: {
      method: "eip712",
      signature: params.signature,
      nonce: params.challenge.nonce,
      issuedAt: params.challenge.issuedAt,
      configHash: params.challenge.configHash,
      verifiedAt: now,
      signerType: isContract ? "contract" : "eoa",
      chainId: params.challenge.chainId,
    },
  };
}

export async function verifyChallengeSignature(params: {
  challenge: OwnerChallenge;
  signature: Hex;
  client: PublicClient;
  usedNonces: ReadonlySet<string>;
  now?: number;
}): Promise<VerifyResult> {
  const { challenge, signature, client, usedNonces } = params;
  const now = params.now ?? Date.now();
  if (usedNonces.has(challenge.nonce)) return { ok: false, reason: "Challenge already used." };
  if (now - challenge.issuedAt > CHALLENGE_TTL_MS) return { ok: false, reason: "Challenge expired. Try again." };
  const clientChain = await client.getChainId();
  if (clientChain !== challenge.chainId) return { ok: false, reason: "Verification chain mismatch." };

  let valid = false;
  try {
    // viem verifies EOAs by ecrecover and contract wallets via ERC-1271 / ERC-6492.
    valid = await client.verifyTypedData({ address: challenge.owner, signature, ...challengeTypedData(challenge) });
  } catch (e) {
    return { ok: false, reason: `Signature check failed: ${(e as Error).message.slice(0, 160)}` };
  }
  if (!valid) return { ok: false, reason: "Signature does not match this owner address." };

  const code = await client.getCode({ address: challenge.owner }).catch(() => undefined);
  const isContract = !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
  return {
    ok: true,
    verification: {
      method: "eip712",
      signature,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      configHash: challenge.configHash,
      verifiedAt: now,
      signerType: isContract ? "contract" : "eoa",
      chainId: challenge.chainId,
    },
  };
}
