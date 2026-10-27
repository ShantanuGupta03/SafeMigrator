import type { HandledAsset, PendingArrival, WatchState } from "@/lib/domain/profile";
import type { DiscoveredAsset, Migration, NetworkDiscovery } from "@/lib/domain/types";

/*
 * Late arrivals: assets that reach the source wallet after a run. Identity is the discovery asset
 * ID, `${chainId}:${standard}:${contract|native}[:${tokenId}]`, i.e. chain, contract, standard and
 * token ID. Assets the user already handled (migrated, deliberately left as gas, excluded, ignored)
 * only come back when their balance grows meaningfully. A failed or partial scan never clears what
 * an earlier scan found: unknown is not "gone".
 *
 * This runs only while the app is open. Nothing here sends a transaction; a sweep is a new,
 * reviewed run through the normal planning and execution path.
 */

/** A handled fungible balance must grow by at least 5% to be reported again. */
export const MEANINGFUL_INCREASE_BPS = 500n;

export function meaningfulIncrease(previous: string, current: string, asset: Pick<DiscoveredAsset, "standard" | "decimals">): boolean {
  const prev = BigInt(previous);
  const now = BigInt(current);
  if (now <= prev) return false;
  const delta = now - prev;
  // Native: ignore changes below 0.001 of the coin (gas refunds, dust).
  if (asset.standard === "native" && delta < 10n ** BigInt(Math.max(0, asset.decimals - 3))) return false;
  if (prev === 0n) return true;
  return delta * 10_000n >= prev * MEANINGFUL_INCREASE_BPS;
}

function upsertHandled(list: readonly HandledAsset[], h: HandledAsset): HandledAsset[] {
  const prior = list.find((x) => x.assetId === h.assetId);
  if (prior && prior.balance === h.balance && prior.reason === h.reason) return [...list];
  return [...list.filter((x) => x.assetId !== h.assetId), h];
}

/**
 * Records what a run took care of, so the next check does not alert about it: migrated assets (with
 * whatever stayed at the source), the native remainder kept for gas, and selected assets that the
 * run excluded. Idempotent.
 */
export function withHandledFromMigration(watch: WatchState, m: Migration, now = Date.now()): WatchState {
  let handled = [...watch.handled];
  const done = new Set<string>();
  for (const c of m.chains) {
    for (const a of c.actions) {
      if (a.kind === "deploy_safe") continue;
      if (a.status !== "verified" && a.status !== "verified_with_discrepancy" && a.status !== "skipped") continue;
      for (const id of a.assetIds) {
        const retained = a.kind === "transfer_native" && a.status === "skipped";
        // Gas dust left on purpose is baselined at the balance the user reviewed; everything else at what stayed behind.
        let remaining = a.verification?.sourceRemaining ?? (retained ? (m.scope?.selectedAssets.find((x) => x.assetId === id)?.amount ?? null) : "0");
        if (remaining === null) continue;
        // Interest-bearing positions keep accruing on any remainder; baseline 0.1% above it so that alone never alerts.
        if (a.protocol) remaining = (BigInt(remaining) + BigInt(a.amounts[0] ?? "0") / 1000n).toString();
        const reason: HandledAsset["reason"] = retained ? "retained" : "migrated";
        handled = upsertHandled(handled, { assetId: id, chainId: c.chainId, balance: remaining, reason, at: now });
        done.add(id);
      }
    }
  }
  for (const x of m.scope?.excludedAssets ?? []) {
    if (done.has(x.assetId)) continue;
    handled = upsertHandled(handled, { assetId: x.assetId, chainId: x.chainId, balance: x.amount, reason: "excluded", at: now });
    done.add(x.assetId);
  }
  return { ...watch, handled, pending: watch.pending.filter((p) => !done.has(p.assetId)) };
}

export function ignoreArrival(watch: WatchState, p: PendingArrival, now = Date.now()): WatchState {
  return {
    ...watch,
    handled: upsertHandled(watch.handled, { assetId: p.assetId, chainId: p.chainId, balance: p.balance, reason: "ignored", at: now }),
    pending: watch.pending.filter((x) => x.assetId !== p.assetId),
  };
}

function label(a: DiscoveredAsset): string {
  return (a.standard === "erc721" || a.standard === "erc1155" ? `${a.name} #${a.tokenId}` : a.symbol).slice(0, 200);
}

export interface ScanSummary {
  watch: WatchState;
  newCount: number;
  hiddenSuspicious: number;
}

/**
 * Folds one scan into the watch state. Per network: an `error` scan changes nothing but its check
 * record; a `partial` scan can add or update arrivals but never removes them; only an `ok` scan
 * removes arrivals that are no longer held. Suspicious assets are never surfaced automatically.
 */
export function applyScan(watch: WatchState, discoveries: Readonly<Record<number, NetworkDiscovery>>, now = Date.now()): ScanSummary {
  const handled = new Map(watch.handled.map((h) => [h.assetId, h]));
  const pending = new Map(watch.pending.map((p) => [p.assetId, p]));
  const checks = new Map(watch.checks.map((c) => [c.chainId, c]));
  let newCount = 0;
  let hiddenSuspicious = 0;

  for (const d of Object.values(discoveries)) {
    checks.set(d.chainId, { chainId: d.chainId, checkedAt: now, status: d.status, note: d.errors.length ? d.errors.join(" ").slice(0, 1000) : null });
    if (d.status === "error") continue;
    const seen = new Set<string>();
    for (const a of d.assets) {
      if (BigInt(a.balance) <= 0n) continue;
      if (a.classification === "suspicious") {
        hiddenSuspicious++;
        continue;
      }
      seen.add(a.id);
      const h = handled.get(a.id);
      const prev = pending.get(a.id);
      if (h && !meaningfulIncrease(h.balance, a.balance, a)) {
        pending.delete(a.id);
        continue;
      }
      if (!prev) newCount++;
      pending.set(a.id, {
        assetId: a.id,
        chainId: a.chainId,
        standard: a.standard,
        contract: a.contract,
        tokenId: a.tokenId,
        label: label(a),
        decimals: a.decimals,
        balance: a.balance,
        previousBalance: h ? h.balance : null,
        kind: h ? "increased" : "new",
        classification: a.classification,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
      });
    }
    if (d.status === "ok") {
      for (const [id, p] of pending) if (p.chainId === d.chainId && !seen.has(id)) pending.delete(id);
    }
  }
  return {
    watch: {
      lastCheckedAt: now,
      checks: [...checks.values()].sort((a, b) => a.chainId - b.chainId),
      handled: watch.handled,
      pending: [...pending.values()].sort((a, b) => a.chainId - b.chainId || a.assetId.localeCompare(b.assetId)),
    },
    newCount,
    hiddenSuspicious,
  };
}

/** Arrivals that can be swept with the standard transfer adapters (the review step decides the rest). */
export function sweepable(p: PendingArrival): boolean {
  return p.classification === "transferable";
}
