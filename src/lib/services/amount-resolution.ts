import type { DiscoveredAsset, MigrationAction } from "@/lib/domain/types";
import { toBigInt } from "@/lib/domain/amounts";
import { extraRetainAmount, maxNativeTransferable, requiredBalanceForExactNative, type GasRetentionPrefs } from "@/lib/domain/gas-retention";
import {
  intentForAsset,
  legacyIntentFromAction,
  resolveFungiblePlannedAmount,
  resolveFungibleSendAmount,
  type AssetTransferIntents,
  type TransferIntent,
} from "@/lib/domain/transfer-intent";

export function intentForAction(
  intents: AssetTransferIntents | undefined,
  asset: DiscoveredAsset | undefined,
  action: Pick<MigrationAction, "amounts" | "previewAmounts" | "assetIds">,
): TransferIntent {
  const id = action.assetIds[0];
  if (id && intents?.[id]) return intents[id]!;
  if (asset) return intentForAsset(intents, asset);
  const preview = action.previewAmounts?.[0] ?? action.amounts[0] ?? "0";
  return legacyIntentFromAction(preview, preview);
}

export function plannedAmountForAsset(params: {
  asset: DiscoveredAsset;
  intents?: AssetTransferIntents;
  nativeSpendableMax?: bigint;
}): { amount: bigint; blocked: string | null } {
  const intent = intentForAsset(params.intents, params.asset);
  const balance = toBigInt(params.asset.balance);
  const spendable =
    params.asset.standard === "native" && params.nativeSpendableMax !== undefined ? params.nativeSpendableMax : balance;
  return resolveFungiblePlannedAmount({ intent, liveBalance: balance, spendableMax: spendable });
}

export function nativeSpendableForPlanning(params: {
  chainId: number;
  liveBalance: bigint;
  remainingExecutionCost: bigint;
  gasRetention?: GasRetentionPrefs;
  intent?: TransferIntent;
}): bigint {
  const extra = extraRetainAmount(params.gasRetention, params.chainId);
  const intent = params.intent ?? { mode: "max" as const, ceiling: params.liveBalance.toString() };
  if (intent.mode === "exact") {
    const exact = toBigInt(intent.amount);
    const need = requiredBalanceForExactNative({ exact, remainingExecutionCost: params.remainingExecutionCost, extraRetain: extra });
    if (params.liveBalance < need) return 0n;
    return exact;
  }
  return maxNativeTransferable({
    liveBalance: params.liveBalance,
    remainingExecutionCost: params.remainingExecutionCost,
    extraRetain: extra,
    reviewedCeiling: toBigInt(intent.ceiling),
  });
}

export function refreshFungibleAmounts(params: {
  intent: TransferIntent;
  previewAmount: bigint;
  liveBalance: bigint;
  spendableMax: bigint;
}): { amounts: string[]; blocked: string | null; materiallyChanged: boolean } {
  const r = resolveFungibleSendAmount({
    intent: params.intent,
    previewAmount: params.previewAmount,
    liveBalance: params.liveBalance,
    spendableMax: params.spendableMax,
  });
  const materiallyChanged = r.changed || r.amount !== params.previewAmount;
  return { amounts: [r.amount.toString()], blocked: r.blocked, materiallyChanged };
}
