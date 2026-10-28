"use client";

import { Checkbox, Input } from "@/components/ui/input";
import { getChain } from "@/lib/chains/registry";
import { formatAmount, toBigInt } from "@/lib/domain/amounts";
import { chainRetention, type GasRetentionPrefs } from "@/lib/domain/gas-retention";
import { parseExactDecimalInput } from "@/lib/domain/transfer-intent";

export function GasRetentionPanel(props: { prefs: GasRetentionPrefs; chainIds: number[]; onChange(p: GasRetentionPrefs): void }) {
  const { prefs, chainIds, onChange } = props;
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4 text-sm">
      <div>
        <p className="font-medium">Keep gas in this wallet</p>
        <p className="text-xs text-muted-foreground">
          Leave an extra balance for future transactions. Gas needed for this migration is always reserved separately and cannot be turned off.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={prefs.applyToAllNetworks} onChange={(e) => onChange({ ...prefs, applyToAllNetworks: e.target.checked })} />
        Apply the same preference across selected networks
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {chainIds.map((id) => {
          const c = getChain(id);
          const row = chainRetention(prefs, id);
          return (
            <div key={id} className="rounded-xl bg-muted/50 p-3">
              <p className="mb-2 text-xs font-medium">{c.name}</p>
              <label className="mb-2 flex items-center gap-2 text-xs">
                <Checkbox
                  checked={row.enabled}
                  onChange={(e) => {
                    const perChain = { ...prefs.perChain, [id]: { ...row, enabled: e.target.checked } };
                    onChange({ ...prefs, perChain });
                  }}
                />
                Keep extra {c.nativeSymbol} after migration
              </label>
              <Input
                className="h-8 font-mono text-xs"
                disabled={!row.enabled}
                value={formatAmount(toBigInt(row.extraRetainRaw), c.nativeDecimals, 6)}
                onChange={(e) => {
                  const parsed = parseExactDecimalInput(e.target.value, c.nativeDecimals);
                  if (!parsed.ok) return;
                  onChange({ ...prefs, perChain: { ...prefs.perChain, [id]: { ...row, extraRetainRaw: parsed.amount.toString() } } });
                }}
              />
              {row.suggestedRaw && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Suggested ~{formatAmount(toBigInt(row.suggestedRaw), c.nativeDecimals)} {c.nativeSymbol} (editable)
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
