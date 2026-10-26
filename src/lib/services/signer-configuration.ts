import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { normalize } from "viem/ens";
import type { SafeConfig, SignerSlot } from "@/lib/domain/types";

export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_OWNER_COUNT = 3;
export const MAX_OWNERS = 10;

export type SignerIssue =
  | { slot: number; code: "empty" | "invalid" | "zero_address" | "duplicate" | "unresolved_ens"; message: string }
  | { slot: null; code: "threshold" | "count"; message: string };

const ENS_PATTERN = /^[^\s]+\.[a-z]{2,}$/i;

export function looksLikeEns(input: string): boolean {
  return ENS_PATTERN.test(input.trim()) && !input.trim().startsWith("0x");
}

/** Parses a raw address string. Rejects mixed-case strings with an invalid checksum. */
export function parseAddressInput(input: string): Address | null {
  const v = input.trim();
  if (!isAddress(v, { strict: true })) return null;
  return getAddress(v);
}

export async function resolveEns(name: string, mainnetClient: PublicClient): Promise<Address | null> {
  try {
    const resolved = await mainnetClient.getEnsAddress({ name: normalize(name.trim()) });
    return resolved ? getAddress(resolved) : null;
  } catch {
    return null;
  }
}

export function validateSigners(slots: readonly SignerSlot[], threshold: number): SignerIssue[] {
  const issues: SignerIssue[] = [];
  if (slots.length < 1 || slots.length > MAX_OWNERS) {
    issues.push({ slot: null, code: "count", message: `A Safe needs between 1 and ${MAX_OWNERS} owners.` });
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > slots.length) {
    issues.push({ slot: null, code: "threshold", message: "Threshold must be between 1 and the number of owners." });
  }
  const seen = new Map<string, number>();
  for (const s of slots) {
    if (!s.input.trim() && !s.address) {
      issues.push({ slot: s.slot, code: "empty", message: "Enter an address or ENS name." });
      continue;
    }
    if (!s.address) {
      issues.push(
        looksLikeEns(s.input)
          ? { slot: s.slot, code: "unresolved_ens", message: "ENS name did not resolve to an address." }
          : { slot: s.slot, code: "invalid", message: "Not a valid EVM address (check the checksum)." },
      );
      continue;
    }
    if (s.address === zeroAddress) {
      issues.push({ slot: s.slot, code: "zero_address", message: "The zero address cannot be an owner." });
      continue;
    }
    const key = s.address.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      issues.push({ slot: s.slot, code: "duplicate", message: `Same address as signer ${prior + 1}.` });
    } else {
      seen.set(key, s.slot);
    }
  }
  return issues;
}

/** Deterministic ordering: ascending by numeric address value. */
export function sortOwners(owners: readonly Address[]): Address[] {
  return [...owners]
    .map((o) => getAddress(o))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/**
 * Deterministic salt nonce per source EOA. Re-deriving it after lost local state yields the same
 * Safe address for the same owners, so existing deployments are recognized instead of duplicated.
 * `variant` lets a user intentionally create a different Safe with identical owners.
 */
export function deriveSaltNonce(source: Address, variant = 0): string {
  return BigInt(keccak256(toHex(`safe-migrator:v1:${source.toLowerCase()}:${variant}`))).toString();
}

export function buildSafeConfig(owners: readonly Address[], threshold: number, saltNonce: string): SafeConfig {
  const sorted = sortOwners(owners);
  if (new Set(sorted.map((o) => o.toLowerCase())).size !== sorted.length) throw new Error("Duplicate owners");
  if (threshold < 1 || threshold > sorted.length) throw new Error("Invalid threshold");
  if (!/^\d+$/.test(saltNonce)) throw new Error("Invalid salt nonce");
  return { owners: sorted, threshold, saltNonce };
}

/** Commitment to the exact Safe configuration; bound into owner-verification challenges. */
export function safeConfigHash(config: SafeConfig): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256" }, { type: "uint256" }],
      [config.owners, BigInt(config.threshold), BigInt(config.saltNonce)],
    ),
  );
}

export interface SignerWarning {
  level: "info" | "warning" | "critical";
  message: string;
}

/**
 * Risks inherent to the threshold itself. A 1-of-N Safe falls to one stolen key; an N-of-N Safe
 * is lost with one missing key. Both are allowed, but must be acknowledged explicitly.
 */
export function thresholdRisk(threshold: number, owners: number): SignerWarning | null {
  if (owners === 1) {
    return {
      level: "critical",
      message: "A 1-of-1 Safe is still controlled by a single key: one stolen or lost key means the assets are gone, just like your current wallet.",
    };
  }
  if (threshold === 1) {
    return {
      level: "critical",
      message: `Any one of the ${owners} owners can move everything alone, so a single stolen key is enough to empty the Safe. Use at least 2 signatures to protect against theft.`,
    };
  }
  if (threshold === owners) {
    return {
      level: "critical",
      message: `Every owner must sign. If any one of the ${owners} keys is lost, the Safe can never move its assets again. Use a threshold below ${owners} so one lost key is survivable.`,
    };
  }
  return null;
}

export function signerWarnings(slots: readonly SignerSlot[], source: Address | null, threshold: number): SignerWarning[] {
  const warnings: SignerWarning[] = [];
  const addrs = slots.map((s) => s.address?.toLowerCase()).filter(Boolean);
  if (source && addrs.includes(source.toLowerCase())) {
    warnings.push({
      level: "warning",
      message:
        "Your current wallet will remain a Safe owner. If that key was ever exposed, replace it with a fresh, independent signer after migrating.",
    });
  }
  const verified = slots.filter((s) => s.verification).length;
  if (verified < threshold) {
    warnings.push({
      level: "warning",
      message: `${verified} of ${slots.length} owners verified. Unverified owners are addresses you typed — the app cannot know you control them. Production-network transfers require ${threshold} verified owner${threshold === 1 ? "" : "s"}.`,
    });
  }
  const hardware = slots.filter((s) => s.kind === "hardware").length;
  if (hardware === 0) {
    warnings.push({
      level: "info",
      message: "Consider at least one hardware wallet signer so a single compromised device cannot control the Safe.",
    });
  }
  return warnings;
}
