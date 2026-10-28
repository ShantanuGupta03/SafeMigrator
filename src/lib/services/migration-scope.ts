import { getChain } from "@/lib/chains/registry";
import type { AssetTransferIntents } from "@/lib/domain/transfer-intent";
import { intentForAsset } from "@/lib/domain/transfer-intent";
import type { DiscoveredAsset, MigrationScope, NetworkDiscovery, ScopeAsset, ScopeChain } from "@/lib/domain/types";
import type { ChainPlan } from "./migration-planning";
import type { EffectiveSelection } from "./selection";

function scopeAsset(a: DiscoveredAsset, reason: string | null, intents?: AssetTransferIntents): ScopeAsset {
  const intent = intentForAsset(intents, a);
  const amount = intent.mode === "exact" ? intent.amount : a.balance;
  return {
    assetId: a.id,
    chainId: a.chainId,
    label: a.standard === "erc721" || a.standard === "erc1155" ? `${a.name} #${a.tokenId}` : a.symbol,
    amount,
    decimals: a.decimals,
    transferIntent: intent,
    reason,
  };
}

export interface ScopeBuildInput {
  selection: EffectiveSelection;
  selectedChainIds: readonly number[];
  plans: readonly ChainPlan[];
  discovery: Readonly<Record<number, NetworkDiscovery | undefined>>;
  partialAcknowledged: boolean;
  plannedAt: number;
  transferIntents?: AssetTransferIntents;
}

/** Records what the user selected versus what will execute, for receipts and completion copy. */
export function buildMigrationScope(input: ScopeBuildInput): MigrationScope {
  const planByChain = new Map(input.plans.map((p) => [p.chainId, p]));
  const included = new Set(input.plans.filter((p) => p.executable).map((p) => p.chainId));
  const selectedAssets = input.selection.assets.map((a) => scopeAsset(a, included.has(a.chainId) ? null : "Network blocked or not executable.", input.transferIntents));
  const blockedChains: ScopeChain[] = [];
  const excludedAssets: ScopeAsset[] = [];

  for (const chainId of input.selectedChainIds) {
    const plan = planByChain.get(chainId);
    if (!plan) {
      blockedChains.push({ chainId, reasons: ["No assets selected on this network."], assetIds: [] });
      continue;
    }
    if (!plan.executable) {
      blockedChains.push({
        chainId,
        reasons: plan.blockers.length ? plan.blockers : ["Preflight blocked this network."],
        assetIds: input.selection.assets.filter((a) => a.chainId === chainId).map((a) => a.id),
      });
    }
    for (const ex of plan.excluded) {
      const assetId = ex.action.assetIds[0] ?? ex.action.id;
      const asset = input.selection.assets.find((a) => a.id === assetId);
      excludedAssets.push(
        asset
          ? scopeAsset(asset, ex.reason)
          : { assetId, chainId, label: ex.action.label, amount: ex.action.amounts[0] ?? "0", decimals: ex.action.decimals, reason: ex.reason },
      );
    }
  }

  const incompleteDiscovery = input.selectedChainIds.flatMap((chainId) => {
    const d = input.discovery[chainId];
    if (!d?.errors.length) return [];
    return [{ chainId, note: `${getChain(chainId).name}: ${d.errors.join(" ")}` }];
  });

  return {
    selectedChainIds: [...input.selectedChainIds],
    selectedAssets,
    includedChainIds: [...included],
    blockedChains,
    excludedAssets,
    partialAcknowledged: input.partialAcknowledged,
    incompleteDiscovery,
    plannedAt: input.plannedAt,
  };
}

export function requiresPartialAck(scope: MigrationScope): boolean {
  return scope.blockedChains.length > 0 || scope.excludedAssets.length > 0;
}
