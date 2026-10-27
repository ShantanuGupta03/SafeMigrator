import type { PublicClient } from "viem";
import { chainsForEnvironment, findChain } from "@/lib/chains/registry";
import type { GovernanceSnapshot, SafeProfile } from "@/lib/domain/profile";
import type { ChainSafeTarget } from "@/lib/domain/types";
import { inspectSafe } from "./onchain-verification";
import { canonicalContractSet } from "./safe-deployment";
import { isPinned, resolvePinnedTarget, snapshotFromInspection, withDeployment, withSnapshot } from "./safe-profile";

/*
 * "Add network" for a saved Safe. The pinned recipe recreates the SAME address on a new network,
 * but it installs the ORIGINAL owners and threshold. If governance changed on any known deployment
 * (or cannot be read), extending would silently create a Safe with different owners at an address
 * users believe is controlled the same way everywhere, so routine extension is blocked. v1.5 does
 * not synchronise owners across networks.
 */

export type ExtensionAction = "deploy" | "reuse" | "blocked";

export interface ExtensionAssessment {
  chainId: number;
  action: ExtensionAction;
  target: ChainSafeTarget;
  /** Fresh observations of every known deployment, to store on the profile. */
  snapshots: GovernanceSnapshot[];
  blockers: string[];
  warnings: string[];
}

const nameOf = (id: number) => findChain(id)?.name ?? `chain ${id}`;

/**
 * Re-reads every known deployment of a pinned profile. Any change from the original configuration,
 * or any read failure, is a reason not to deploy the original recipe on another network.
 */
export async function knownDeploymentGovernance(profile: SafeProfile, clientFor: (chainId: number) => PublicClient, now = Date.now()): Promise<{ snapshots: GovernanceSnapshot[]; blockers: string[] }> {
  const snapshots: GovernanceSnapshot[] = [];
  const blockers: string[] = [];
  if (!isPinned(profile)) return { snapshots, blockers: ["This saved Safe has no trusted deployment recipe."] };
  const contracts = canonicalContractSet(profile.recipe.safeVersion);
  for (const d of profile.deployments) {
    try {
      const insp = await inspectSafe(clientFor(d.chainId), profile.safeAddress);
      const s = snapshotFromInspection(d.chainId, insp, profile.original, contracts, now);
      snapshots.push(s);
      if (!s.isSafe) blockers.push(`${nameOf(d.chainId)}: no Safe found at the recorded address. Resolve this before adding networks.`);
      else if (!s.matchesOriginal) {
        blockers.push(
          `${nameOf(d.chainId)}: the Safe's owners or settings changed since deployment (${s.issues.join(" ")}). A new deployment would install the ORIGINAL owners and threshold at the same address, which is not what this Safe is anymore. v1.5 does not synchronise owners; create a separate Safe through the normal flow instead.`,
        );
      }
    } catch (e) {
      blockers.push(`${nameOf(d.chainId)}: governance could not be read (${(e as Error).message.slice(0, 120)}). Retry when the network is reachable.`);
    }
  }
  return { snapshots, blockers };
}

export async function assessExtension(params: { profile: SafeProfile; chainId: number; clientFor: (chainId: number) => PublicClient; now?: number }): Promise<ExtensionAssessment> {
  const { profile, chainId } = params;
  const now = params.now ?? Date.now();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const blocked = (target: ChainSafeTarget, reasons: string[], snapshots: GovernanceSnapshot[] = []): ExtensionAssessment => ({ chainId, action: "blocked", target, snapshots, blockers: reasons, warnings });

  const emptyTarget: ChainSafeTarget = { chainId, safeVersion: null, contracts: null, predictedAddress: null, status: "error", inspection: null, issues: [], pinned: true };
  if (!isPinned(profile)) return blocked(emptyTarget, ["This saved Safe has no trusted deployment recipe. Recover it first."]);
  if (!chainsForEnvironment(profile.environment).some((c) => c.id === chainId)) return blocked(emptyTarget, [`${nameOf(chainId)} is not part of this Safe's environment.`]);
  if (profile.deployments.some((d) => d.chainId === chainId)) return blocked(emptyTarget, [`The Safe is already recorded on ${nameOf(chainId)}.`]);

  // 1. Re-read governance on every known deployment. Unknown is treated like diverged: block.
  const known = await knownDeploymentGovernance(profile, params.clientFor, now);
  const snapshots = known.snapshots;
  blockers.push(...known.blockers);
  if (profile.deployments.length === 0) warnings.push("The Safe is not recorded as deployed anywhere yet; this will be its first deployment.");

  // 2. Resolve the target from the pinned recipe only.
  const target = await resolvePinnedTarget(chainId, params.clientFor(chainId), profile);
  switch (target.status) {
    case "not_deployed":
      break;
    case "deployed_matching":
      warnings.push(`A Safe with exactly the original configuration already exists at this address on ${nameOf(chainId)}. It will be recorded; nothing is deployed.`);
      break;
    case "deployed_governance_changed":
      blockers.push(`A Safe already exists at this address on ${nameOf(chainId)} but its configuration differs from the original: ${target.issues.join(" ")} It is not reused automatically.`);
      break;
    case "deployed_mismatch":
      blockers.push(`A different contract occupies this address on ${nameOf(chainId)}: ${target.issues.join(" ")}`);
      break;
    case "incompatible":
      blockers.push(...target.issues);
      break;
    default:
      blockers.push(target.unavailable ? `${nameOf(chainId)} could not be read; its state is unknown. ${target.issues.join(" ")}` : target.issues.join(" ") || "The Safe address could not be verified.");
  }

  if (blockers.length) return { chainId, action: "blocked", target, snapshots, blockers, warnings };
  return { chainId, action: target.status === "deployed_matching" ? "reuse" : "deploy", target, snapshots, blockers, warnings };
}

/** Stores fresh observations, and a reused Safe as a known deployment. */
export function applyAssessment(profile: SafeProfile, a: ExtensionAssessment, now = Date.now()): SafeProfile {
  let next = profile;
  for (const s of a.snapshots) next = withSnapshot(next, s);
  if (a.action === "reuse" && a.target.inspection && isPinned(profile)) {
    next = withDeployment(next, { chainId: a.chainId, address: profile.safeAddress, txHash: null, how: "existing", runId: null, recordedAt: now });
    next = withSnapshot(next, snapshotFromInspection(a.chainId, a.target.inspection, profile.original, canonicalContractSet(profile.recipe.safeVersion), now));
  }
  return next;
}
