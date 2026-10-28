import type { AssetTransferIntents } from "@/lib/domain/transfer-intent";
import type { DiscoveredAsset, NetworkDiscovery } from "@/lib/domain/types";
import type { ManualImport } from "./discovery/asset-discovery";
import { isManuallySelectable } from "./discovery/classification";

export type DroppedReason = "network_not_selected" | "not_in_environment" | "not_discovered" | "not_selectable" | "needs_acknowledgement" | "zero_balance";

export interface EffectiveSelection {
  /** Networks that are selected AND have at least one effectively selected asset, in environment order. */
  chainIds: number[];
  /** The only assets that may be planned, simulated or transferred. */
  assets: DiscoveredAsset[];
  assetIds: string[];
  /** Selected IDs that do not authorize anything, and why. */
  dropped: { assetId: string; reason: DroppedReason }[];
}

const chainOfId = (id: string) => Number(id.split(":")[0]);

/**
 * The single source of truth for "what will be migrated". An asset counts only if its network is
 * selected and part of the environment, the latest discovery for that network still contains it
 * with a positive balance, and its classification allows selection. Anything else — stale IDs from
 * an earlier session, assets on a deselected network, suspicious tokens without acknowledgement —
 * is dropped here and can never reach planning or execution.
 */
export function effectiveSelection(params: {
  envChainIds: readonly number[];
  selectedChains: readonly number[];
  selectedAssetIds: readonly string[];
  acknowledgedSuspicious: readonly string[];
  discovery: Readonly<Record<number, NetworkDiscovery | undefined>>;
}): EffectiveSelection {
  const env = new Set(params.envChainIds);
  const chains = new Set(params.selectedChains.filter((id) => env.has(id)));
  const acknowledged = new Set(params.acknowledgedSuspicious);
  const assets: DiscoveredAsset[] = [];
  const dropped: EffectiveSelection["dropped"] = [];

  for (const id of new Set(params.selectedAssetIds)) {
    const chainId = chainOfId(id);
    if (!env.has(chainId)) {
      dropped.push({ assetId: id, reason: "not_in_environment" });
      continue;
    }
    if (!chains.has(chainId)) {
      dropped.push({ assetId: id, reason: "network_not_selected" });
      continue;
    }
    const asset = params.discovery[chainId]?.assets.find((a) => a.id === id && a.chainId === chainId);
    if (!asset) {
      dropped.push({ assetId: id, reason: "not_discovered" });
      continue;
    }
    if (!isManuallySelectable(asset.classification)) {
      dropped.push({ assetId: id, reason: "not_selectable" });
      continue;
    }
    if (asset.classification === "suspicious" && !acknowledged.has(id)) {
      dropped.push({ assetId: id, reason: "needs_acknowledgement" });
      continue;
    }
    if (BigInt(asset.balance) <= 0n) {
      dropped.push({ assetId: id, reason: "zero_balance" });
      continue;
    }
    assets.push(asset);
  }

  const withAssets = new Set(assets.map((a) => a.chainId));
  const chainIds = params.envChainIds.filter((id) => chains.has(id) && withAssets.has(id));
  return { chainIds, assets, assetIds: assets.map((a) => a.id), dropped };
}

/** Removes a network's asset IDs from a selection (used when the network is deselected). */
export function withoutChain(selectedAssetIds: readonly string[], chainId: number): string[] {
  return selectedAssetIds.filter((id) => chainOfId(id) !== chainId);
}

export function withoutChains(selectedAssetIds: readonly string[], chainIds: readonly number[]): string[] {
  const set = new Set(chainIds);
  return selectedAssetIds.filter((id) => !set.has(chainOfId(id)));
}

/** Manual imports are only scanned for, and only count on, selected networks. */
export function importsForChains(imports: readonly ManualImport[], chainIds: readonly number[]): ManualImport[] {
  const set = new Set(chainIds);
  return imports.filter((m) => set.has(m.chainId));
}

/** A stable key for "the inputs a preflight was computed from"; any change invalidates it. */
export function selectionKey(sel: EffectiveSelection, intents?: AssetTransferIntents): string {
  const base = sel.assets
    .map((a) => `${a.id}=${a.balance}`)
    .sort()
    .join("|");
  if (!intents || !Object.keys(intents).length) return base;
  const intentPart = Object.entries(intents)
    .filter(([id]) => sel.assetIds.includes(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, i]) => (i.mode === "exact" ? `${id}:e:${i.amount}` : `${id}:m:${i.ceiling}`))
    .join("|");
  return `${base}::${intentPart}`;
}
