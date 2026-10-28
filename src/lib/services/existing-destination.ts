import type { Address, PublicClient } from "viem";
import { getAddress, zeroAddress } from "viem";
import { canonicalContractSet } from "./safe-deployment";
import { classifyDeployed, snapshotFromInspection } from "./safe-profile";
import { compareSafeToConfig, inspectSafe } from "./onchain-verification";
import type { ChainSafeTarget, SafeConfig, SafeContractSet, SupportedSafeVersion } from "@/lib/domain/types";
import { findChain } from "@/lib/chains/registry";

export interface ExistingSafePolicy {
  /** Documented unsupported settings that block migration into this Safe. */
  blockIfModules: boolean;
  blockIfCustomGuard: boolean;
  blockIfNonCanonicalSingleton: boolean;
}

export const DEFAULT_EXISTING_SAFE_POLICY: ExistingSafePolicy = {
  blockIfModules: true,
  blockIfCustomGuard: true,
  blockIfNonCanonicalSingleton: true,
};

export interface ExistingSafeAssessment {
  chainId: number;
  address: Address;
  target: ChainSafeTarget;
  snapshot: ReturnType<typeof snapshotFromInspection> | null;
  securityNotes: string[];
}

function unsupportedSettingsIssues(
  inspection: NonNullable<ChainSafeTarget["inspection"]>,
  contracts: SafeContractSet,
  policy: ExistingSafePolicy,
): string[] {
  const issues: string[] = [];
  if (policy.blockIfModules && inspection.modules.length > 0) issues.push("Safe has enabled modules; not supported in this build.");
  if (policy.blockIfCustomGuard && inspection.guard && inspection.guard.toLowerCase() !== zeroAddress) issues.push("Safe has a transaction guard; review manually — migration blocked.");
  if (policy.blockIfNonCanonicalSingleton && inspection.singleton && inspection.singleton.toLowerCase() !== contracts.singleton.toLowerCase()) {
    issues.push("Safe uses a non-canonical singleton.");
  }
  return issues;
}

/**
 * Resolves an existing Safe on one network. Never plans deployment from an imported address alone.
 */
export async function resolveExistingSafeTarget(params: {
  chainId: number;
  address: Address;
  environment: "testnet" | "mainnet";
  client: PublicClient;
  /** When known, used only to label governance drift — not to impose new-Safe defaults. */
  referenceConfig?: SafeConfig | null;
  policy?: ExistingSafePolicy;
}): Promise<ExistingSafeAssessment> {
  const policy = params.policy ?? DEFAULT_EXISTING_SAFE_POLICY;
  const chain = findChain(params.chainId);
  const addr = getAddress(params.address);
  const base: ChainSafeTarget = {
    chainId: params.chainId,
    safeVersion: null,
    contracts: null,
    predictedAddress: addr,
    status: "error",
    inspection: null,
    issues: [],
  };
  if (!chain || chain.environment !== params.environment) {
    return { chainId: params.chainId, address: addr, target: { ...base, status: "incompatible", issues: ["Network not in selected environment."] }, snapshot: null, securityNotes: [] };
  }
  let inspection;
  try {
    inspection = await inspectSafe(params.client, addr);
  } catch (e) {
    return {
      chainId: params.chainId,
      address: addr,
      target: { ...base, unavailable: true, issues: [`Could not read ${chain.name}: ${(e as Error).message.slice(0, 140)}`] },
      snapshot: null,
      securityNotes: [],
    };
  }
  if (!inspection.hasCode) {
    return {
      chainId: params.chainId,
      address: addr,
      target: { ...base, inspection, status: "not_deployed", issues: [`No Safe deployed at this address on ${chain.name}.`] },
      snapshot: null,
      securityNotes: [],
    };
  }
  const version = (inspection.version?.startsWith("1.4") ? "1.4.1" : inspection.version?.startsWith("1.3") ? "1.3.0" : null) as SupportedSafeVersion | null;
  const contracts = version ? canonicalContractSet(version) : null;
  let status: ChainSafeTarget["status"] = inspection.isSafe ? "deployed_matching" : "deployed_mismatch";
  const issues: string[] = [];
  if (!inspection.isSafe) issues.push("Contract at this address is not a recognised Safe.");
  const securityNotes = inspection.isSafe && contracts ? unsupportedSettingsIssues(inspection, contracts, policy) : [];
  if (securityNotes.length) {
    status = "incompatible";
    issues.push(...securityNotes);
  }
  if (securityNotes.length === 0 && params.referenceConfig && contracts && inspection.isSafe) {
    const g = classifyDeployed(inspection, params.referenceConfig, contracts);
    if (g.status === "deployed_governance_changed") {
      status = "deployed_governance_changed";
      issues.push(...g.issues);
    } else if (g.status === "deployed_mismatch") {
      status = "deployed_mismatch";
      issues.push(...g.issues);
    }
  }
  const snapshot =
    inspection.isSafe && contracts && params.referenceConfig
      ? snapshotFromInspection(params.chainId, inspection, params.referenceConfig, contracts)
      : inspection.isSafe
        ? snapshotFromInspection(params.chainId, inspection, { owners: inspection.owners, threshold: inspection.threshold, saltNonce: "0" }, contracts ?? canonicalContractSet("1.3.0"))
        : null;
  return {
    chainId: params.chainId,
    address: addr,
    target: { ...base, safeVersion: version, contracts, inspection, status, issues },
    snapshot,
    securityNotes,
  };
}
