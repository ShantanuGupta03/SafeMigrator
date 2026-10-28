"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount, toBigInt } from "@/lib/domain/amounts";
import type { DiscoveredAsset } from "@/lib/domain/types";
import { defaultMaxIntent, isFungibleAmountEditable, parseExactDecimalInput, type AssetTransferIntents, type TransferIntent } from "@/lib/domain/transfer-intent";

export function AssetAmountControl(props: {
  asset: DiscoveredAsset;
  selected: boolean;
  intent: TransferIntent;
  onIntent(i: TransferIntent): void;
}) {
  const { asset, selected, intent, onIntent } = props;
  const [draft, setDraft] = useState("");
  const balance = toBigInt(asset.balance);
  if (!selected || !isFungibleAmountEditable(asset.standard)) return null;

  const remainingPreview = intent.mode === "exact" ? balance - toBigInt(intent.amount) : 0n;

  const applyMax = () => onIntent(defaultMaxIntent(asset.balance));

  const applyExact = () => {
    const parsed = parseExactDecimalInput(draft || formatAmount(balance, asset.decimals, asset.decimals), asset.decimals);
    if (!parsed.ok) return;
    onIntent({ mode: "exact", amount: parsed.amount.toString() });
  };

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-[160px] font-mono text-sm"
          placeholder="Amount"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Amount for ${asset.symbol}`}
        />
        <Button type="button" size="sm" variant="outline" onClick={applyMax}>
          Max
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={applyExact}>
          Set exact
        </Button>
      </div>
      <p className="text-muted-foreground">
        Available {formatAmount(balance, asset.decimals)} {asset.symbol}
        {intent.mode === "exact" && (
          <>
            {" "}
            · Remaining in wallet ≈ {formatAmount(remainingPreview > 0n ? remainingPreview : 0n, asset.decimals)} {asset.symbol}
          </>
        )}
        {intent.mode === "max" && <> · Reviewed maximum {formatAmount(toBigInt(intent.ceiling), asset.decimals)}</>}
      </p>
    </div>
  );
}

export function intentForDraft(intents: AssetTransferIntents, asset: DiscoveredAsset): TransferIntent {
  return intents[asset.id] ?? defaultMaxIntent(asset.balance);
}

export function setIntent(intents: AssetTransferIntents, assetId: string, intent: TransferIntent): AssetTransferIntents {
  return { ...intents, [assetId]: intent };
}
