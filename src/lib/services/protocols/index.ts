import type { Address, PublicClient } from "viem";
import type { DiscoveredAsset, MigrationAction } from "@/lib/domain/types";
import type { VerifyOutcome } from "../asset-transfer";
import { aaveV3Adapter } from "./aave-v3";
import type { ProtocolAdapter } from "./types";

export const PROTOCOL_ADAPTERS: readonly ProtocolAdapter[] = [aaveV3Adapter];

export function adapterFor(action: Pick<MigrationAction, "protocol">): ProtocolAdapter | null {
  return action.protocol ? (PROTOCOL_ADAPTERS.find((a) => a.id === action.protocol!.adapter) ?? null) : null;
}

/** Runs every enabled adapter over a network's discovered assets. A failing adapter changes nothing. */
export async function enrichWithAdapters(params: { chainId: number; source: Address; assets: readonly DiscoveredAsset[]; client: PublicClient }): Promise<DiscoveredAsset[]> {
  let assets = [...params.assets];
  for (const adapter of PROTOCOL_ADAPTERS) {
    if (!adapter.enabled()) continue;
    try {
      assets = await adapter.enrich({ ...params, assets });
    } catch {
      // Identification failed: positions stay as classified by discovery (specialized).
    }
  }
  return assets;
}

export function interpretWithAdapter(action: MigrationAction, outcome: VerifyOutcome): VerifyOutcome {
  const adapter = adapterFor(action);
  return adapter ? adapter.interpretVerification(action, outcome) : outcome;
}
