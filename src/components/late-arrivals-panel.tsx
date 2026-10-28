"use client";

import { ArrowRight, BellRing, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment, getChain } from "@/lib/chains/registry";
import { formatAmount } from "@/lib/domain/amounts";
import type { PendingArrival, SafeProfile } from "@/lib/domain/profile";
import type { NetworkDiscovery } from "@/lib/domain/types";
import { discoverNetwork, fetchIndexerViaApi } from "@/lib/services/discovery/asset-discovery";
import { applyScan, ignoreArrival, reconsiderHandled, sweepable } from "@/lib/services/late-arrivals";
import { useAppState } from "./app-state";
import { ChainLabel, timeAgo } from "./shared";

const RETURN_RESCAN_AFTER_MS = 10 * 60 * 1000;
/** Upper bound on automatic checks per page session, whatever the interval. */
const MAX_AUTO_CHECKS = 24;

/**
 * Late arrivals for a saved Safe: checks the source wallet for assets that arrived after earlier
 * runs and prepares a reviewed sweep. Checking is read-only; nothing is signed or sent from here.
 * It only runs while this page is open (and, for automatic checks, visible).
 */
export function LateArrivalsPanel({ profile, onUpdate }: { profile: SafeProfile; onUpdate(fn: (p: SafeProfile) => SafeProfile): void }) {
  const { draft, setDraft, setStep, selectProfile, scan } = useAppState();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const inFlight = useRef(false);
  const autoCount = useRef(0);
  const latest = useRef(profile);
  useEffect(() => {
    latest.current = profile;
  }, [profile]);

  const check = useCallback(
    async (reason: "manual" | "return" | "auto") => {
      if (inFlight.current) return;
      inFlight.current = true;
      setChecking(true);
      try {
        const p = latest.current;
        const chains = chainsForEnvironment(p.environment).map((c) => c.id);
        const imports = [...p.manualImports, ...draft.manualImports];
        const results = await Promise.all(
          chains.map(async (chainId): Promise<[number, NetworkDiscovery]> => [
            chainId,
            await discoverNetwork({ chainId, owner: p.source, client: getPublicClient(chainId), manualImports: imports.filter((m) => m.chainId === chainId), fetchIndexer: fetchIndexerViaApi }),
          ]),
        );
        let summary = { newCount: 0, hiddenSuspicious: 0 };
        onUpdate((cur) => {
          const r = applyScan(cur.watch, Object.fromEntries(results));
          summary = r;
          return { ...cur, watch: r.watch };
        });
        setMessage(
          `${reason === "auto" ? "Automatic check" : reason === "return" ? "Checked on return" : "Checked"}: ${summary.newCount} new item(s)${summary.hiddenSuspicious ? `, ${summary.hiddenSuspicious} suspicious token(s) hidden` : ""}.`,
        );
      } catch (e) {
        setMessage(`Check failed: ${(e as Error).message.slice(0, 160)}. Earlier results are kept.`);
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    },
    [draft.manualImports, onUpdate],
  );

  // Rescan when the user comes back to this page after a while.
  useEffect(() => {
    const last = latest.current.watch.lastCheckedAt;
    if (!last || Date.now() - last > RETURN_RESCAN_AFTER_MS) void check("return");
    // Once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optional polling: only while the tab is visible, never overlapping, bounded per session.
  const { autoCheck, intervalMinutes } = profile.monitoring;
  useEffect(() => {
    if (!autoCheck) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      timer = setInterval(() => {
        if (document.visibilityState !== "visible" || autoCount.current >= MAX_AUTO_CHECKS) return;
        autoCount.current++;
        void check("auto");
      }, intervalMinutes * 60_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoCheck, intervalMinutes, check]);

  const w = profile.watch;
  const pending = w.pending;
  const chosen = pending.filter((p) => selected.includes(p.assetId) && sweepable(p));

  const reviewSweep = () => {
    selectProfile(profile.id);
    const chainIds = [...new Set(chosen.map((p) => p.chainId))];
    const imports = [...draft.manualImports, ...profile.manualImports.filter((m) => !draft.manualImports.some((x) => x.chainId === m.chainId && x.contract === m.contract && x.tokenId === m.tokenId))];
    setDraft((d) => ({ ...d, selectedChains: chainIds, selectedAssetIds: chosen.map((p) => p.assetId), acknowledgedSuspicious: [], manualImports: imports }));
    // Fresh balances for the review: nothing from this check is reused for planning.
    void scan(chainIds, imports);
    setStep("discover");
  };

  return (
    <div className="space-y-3 rounded-xl bg-muted p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <BellRing className="size-4" /> New assets in the source wallet
        </p>
        <Button size="sm" variant="outline" onClick={() => void check("manual")} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check for new assets
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {w.lastCheckedAt ? `Last checked ${timeAgo(w.lastCheckedAt)}.` : "Not checked yet."} Checks run only while this app is open; nothing is monitored after you close it, and
        nothing is ever sent automatically.
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        {w.checks.map((c) => (
          <span key={c.chainId} title={c.note ?? undefined}>
            <Badge variant={c.status === "ok" ? "outline" : "warning"}>
              {getChain(c.chainId).name}: {c.status === "ok" ? "complete" : c.status === "partial" ? "partial coverage" : "not reachable (unknown)"}
            </Badge>
          </span>
        ))}
      </div>
      {message && <p className="text-xs">{message}</p>}
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing new since your last run{w.checks.some((c) => c.status !== "ok") ? " on the networks that could be read" : ""}.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {pending.map((p) => (
            <ArrivalRow
              key={p.assetId}
              p={p}
              checked={selected.includes(p.assetId)}
              onToggle={(on) => setSelected((s) => (on ? [...s, p.assetId] : s.filter((x) => x !== p.assetId)))}
              onIgnore={() => onUpdate((cur) => ({ ...cur, watch: ignoreArrival(cur.watch, p) }))}
            />
          ))}
        </ul>
      )}
      {w.handled.filter((h) => h.reason === "ignored").length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Dismissed items</p>
          <ul className="space-y-1 text-xs">
            {w.handled
              .filter((h) => h.reason === "ignored")
              .slice(0, 8)
              .map((h) => (
                <li key={h.assetId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-2 py-1">
                  <span className="truncate font-mono">{h.assetId.split(":").slice(-2).join(":")}</span>
                  <Button size="sm" variant="ghost" onClick={() => onUpdate((cur) => ({ ...cur, watch: reconsiderHandled(cur.watch, h.assetId) }))}>
                    Reconsider
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <Checkbox
            checked={autoCheck}
            onChange={(e) => onUpdate((cur) => ({ ...cur, monitoring: { ...cur.monitoring, autoCheck: e.target.checked } }))}
          />
          Check automatically every
          <Select
            className="h-8 text-xs"
            value={intervalMinutes}
            aria-label="Check interval"
            onChange={(e) => onUpdate((cur) => ({ ...cur, monitoring: { ...cur.monitoring, intervalMinutes: Number(e.target.value) } }))}
          >
            {[15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </Select>
          while this tab is visible
        </label>
        <Button size="sm" disabled={chosen.length === 0} onClick={reviewSweep}>
          Review sweep ({chosen.length}) <ArrowRight />
        </Button>
      </div>
      {chosen.length > 0 && (
        <Alert variant="info">
          A sweep is a new run to this saved Safe through the normal review: balances are re-read, transfers simulated and the Safe&apos;s current owners checked again. You
          approve every transaction in your wallet.
        </Alert>
      )}
    </div>
  );
}

function ArrivalRow({ p, checked, onToggle, onIgnore }: { p: PendingArrival; checked: boolean; onToggle(on: boolean): void; onIgnore(): void }) {
  const amount = p.standard === "erc721" ? "1 NFT" : `${formatAmount(p.balance, p.decimals)}${p.standard === "native" ? ` ${getChain(p.chainId).nativeSymbol}` : ""}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
      <label className="flex min-w-0 items-center gap-2">
        <Checkbox checked={checked} disabled={!sweepable(p)} onChange={(e) => onToggle(e.target.checked)} aria-label={`Select ${p.label} on ${getChain(p.chainId).name}`} />
        <span className="truncate font-medium">{p.label}</span>
        <ChainLabel chainId={p.chainId} className="text-xs" />
      </label>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{amount}</span>
        <Badge variant={p.kind === "new" ? "brand" : "warning"}>
          {p.kind === "new" ? "new" : `increased from ${p.standard === "erc721" ? "0" : formatAmount(p.previousBalance ?? "0", p.decimals)}`}
        </Badge>
        {!sweepable(p) && <Badge variant="outline">{p.classification.replace("_", " ")}: not sweepable here</Badge>}
        <Button size="sm" variant="ghost" onClick={onIgnore} aria-label={`Ignore ${p.label} on ${getChain(p.chainId).name}`}>
          <EyeOff /> Ignore
        </Button>
      </span>
    </li>
  );
}
