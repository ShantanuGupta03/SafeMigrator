import type { Address } from "viem";
import type { GasRetentionPrefs } from "./gas-retention";
import type { ProfileDestinationKind } from "./profile";
import type { AssetTransferIntents } from "./transfer-intent";
import type { Environment, ExpectedGovernance, SafeConfig } from "./types";

export type { ProfileDestinationKind };

/** Where migrated assets should land. Separate from source wallet and per-chain deployment state. */
export type MigrationDestination =
  | {
      kind: "new_safe";
      /** Signer-derived configuration; address is predicted per chain from the pinned recipe. */
      config: SafeConfig;
    }
  | {
      kind: "existing_safe";
      /** Primary address the user supplied (ENS-resolved before storage). */
      address: Address;
      /** Optional per-chain override when the same logical Safe uses a different address. */
      perChain?: Partial<Record<number, Address>>;
      /** User-reviewed governance per chain after inspection. */
      reviewedGovernance?: Partial<Record<number, ExpectedGovernance>>;
    };

export function destinationAddress(dest: MigrationDestination, chainId: number): Address | null {
  if (dest.kind === "new_safe") return null;
  return dest.perChain?.[chainId] ?? dest.address;
}

export function isExistingDestination(dest: MigrationDestination | undefined | null): dest is Extract<MigrationDestination, { kind: "existing_safe" }> {
  return dest?.kind === "existing_safe";
}

export function defaultNewDestination(config: SafeConfig): MigrationDestination {
  return { kind: "new_safe", config };
}

export function profileAllowsNetworkDeploy(kind: ProfileDestinationKind | undefined): boolean {
  return (kind ?? "created") === "created";
}

export interface AssessmentDraft {
  environment: Environment;
  source: Address;
  selectedChains: number[];
  selectedAssetIds: string[];
  transferIntents: AssetTransferIntents;
  gasRetention: GasRetentionPrefs;
  destination: MigrationDestination;
  acknowledgedSuspicious: string[];
  assessedAt: number;
}
