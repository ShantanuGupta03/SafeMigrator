import type { Address } from "viem";
import { chainsForEnvironment } from "@/lib/chains/registry";
import type { GasRetentionPrefs } from "@/lib/domain/gas-retention";
import type { AssetTransferIntents } from "@/lib/domain/transfer-intent";
import type { Environment, NetworkDiscovery } from "@/lib/domain/types";
import { discoverNetwork, fetchIndexerViaApi, type ManualImport } from "./discovery/asset-discovery";
import { enrichWithAdapters } from "./protocols";
import { effectiveSelection } from "./selection";
import type { PublicClient } from "viem";

export interface WalletAssessment {
  source: Address;
  environment: Environment;
  discovery: Record<number, NetworkDiscovery>;
  selection: ReturnType<typeof effectiveSelection>;
  assessedAt: number;
  /** Indicative only — wallet batching unknown until connected. */
  note: string;
}

export async function assessPublicWallet(params: {
  source: Address;
  environment: Environment;
  selectedChains: number[];
  selectedAssetIds: string[];
  acknowledgedSuspicious: string[];
  manualImports: ManualImport[];
  clientFor: (chainId: number) => PublicClient;
}): Promise<WalletAssessment> {
  const envChains = chainsForEnvironment(params.environment).map((c) => c.id);
  const chains = params.selectedChains.filter((id) => envChains.includes(id));
  const discovery: Record<number, NetworkDiscovery> = {};
  const imports = params.manualImports.filter((m) => chains.includes(m.chainId));
  await Promise.all(
    chains.map(async (chainId) => {
      const client = params.clientFor(chainId);
      const base = await discoverNetwork({ chainId, owner: params.source, client, manualImports: imports, fetchIndexer: fetchIndexerViaApi });
      const enriched = await enrichWithAdapters({ chainId, source: params.source, assets: base.assets, client });
      discovery[chainId] = { ...base, assets: enriched };
    }),
  );
  const selection = effectiveSelection({
    envChainIds: envChains,
    selectedChains: chains,
    selectedAssetIds: params.selectedAssetIds,
    acknowledgedSuspicious: params.acknowledgedSuspicious,
    discovery,
  });
  return {
    source: params.source,
    environment: params.environment,
    discovery,
    selection,
    assessedAt: Date.now(),
    note: "Gas and confirmation counts are indicative. Connect the same wallet to build an executable plan.",
  };
}
