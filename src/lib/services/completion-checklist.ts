import { getChain } from "@/lib/chains/registry";
import { formatAmount, toBigInt } from "@/lib/domain/amounts";
import { extraRetainAmount } from "@/lib/domain/gas-retention";
import type { Migration } from "@/lib/domain/types";
import { chainOutcome, hasRetryable, migrationOutcome, SUCCESS_STATUSES } from "@/lib/state/machine";
import type { LiveObservation } from "./receipt";

export type ChecklistKind = "observed" | "user_ack" | "advice" | "unknown";

export interface ChecklistItem {
  id: string;
  kind: ChecklistKind;
  title: string;
  detail: string | null;
  /** Primary action for this outcome, when applicable. */
  primary?: boolean;
  action?: "retry" | "receipt_json" | "receipt_pdf" | "progress" | "sweep" | "safe_wallet" | "revoke_external";
}

export function buildCompletionChecklist(m: Migration, live?: Record<number, LiveObservation> | null): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const summary = migrationOutcome(m);
  const scope = m.scope;

  for (const c of m.chains) {
    const meta = getChain(c.chainId);
    const transfers = c.actions.filter((a) => a.kind !== "deploy_safe");
    for (const a of transfers) {
      const scoped = scope?.selectedAssets.find((x) => x.assetId === a.assetIds[0]);
      const intent = a.transferIntent ?? (scoped?.transferIntent ?? null);
      const requested = intent?.mode === "exact" ? intent.amount : intent?.mode === "max" ? intent.ceiling : a.previewAmounts?.[0] ?? a.amounts[0];
      const verified = a.verification?.safeDelta ?? a.verification?.loggedAmount;
      if (SUCCESS_STATUSES.has(a.status) && (a.status === "verified" || a.status === "verified_with_discrepancy")) {
        items.push({
          id: `verified:${a.id}`,
          kind: "observed",
          title: `${meta.name}: ${a.label}`,
          detail: `Requested ${formatAmount(toBigInt(requested ?? "0"), a.decimals)} ${a.symbol}; verified received ${verified ? formatAmount(toBigInt(verified), a.decimals) : "—"} ${a.symbol}.`,
        });
      } else if (a.status === "skipped" && a.verification?.note?.includes("dust")) {
        items.push({
          id: `retained:${a.id}`,
          kind: "observed",
          title: `${meta.name}: native retained`,
          detail: a.verification?.note ?? "Remaining native balance kept in the source wallet by design.",
        });
      } else if (a.status !== "planned" && !SUCCESS_STATUSES.has(a.status)) {
        items.push({
          id: `open:${a.id}`,
          kind: "observed",
          title: `${meta.name}: ${a.label} — ${a.status.replace(/_/g, " ")}`,
          detail: a.error?.message ?? a.verification?.note ?? null,
          action: a.status === "uncertain" || a.status === "needs_attention" ? "progress" : "retry",
        });
      }
    }
    const outcome = chainOutcome(c);
    if (outcome !== "completed") {
      items.push({
        id: `chain:${c.chainId}`,
        kind: "observed",
        title: `${meta.name} network outcome: ${outcome}`,
        detail: c.message,
        action: "progress",
        primary: summary.outcome === "uncertain",
      });
    }
  }

  if (scope) {
    for (const ex of scope.excludedAssets) {
      items.push({
        id: `excluded:${ex.assetId}`,
        kind: "observed",
        title: `Not migrated: ${ex.label}`,
        detail: ex.reason ?? "Excluded at review.",
      });
    }
    for (const b of scope.blockedChains) {
      items.push({
        id: `blocked:${b.chainId}`,
        kind: "observed",
        title: `Network blocked: ${getChain(b.chainId).name}`,
        detail: b.reasons.join(" "),
      });
    }
  }

  if (m.gasRetention) {
    for (const c of m.chains) {
      const extra = extraRetainAmount(m.gasRetention, c.chainId);
      if (extra > 0n) {
        items.push({
          id: `gas-buffer:${c.chainId}`,
          kind: "observed",
          title: `${getChain(c.chainId).name}: extra gas retention target`,
          detail: `Optional retain ~${formatAmount(extra, getChain(c.chainId).nativeDecimals)} ${getChain(c.chainId).nativeSymbol} in source (estimate; actual fees may differ).`,
        });
      }
    }
  }

  for (const c of m.chains) {
    const o = live?.[c.chainId];
    if (o?.inspection?.isSafe) {
      items.push({
        id: `owners:${c.chainId}`,
        kind: "observed",
        title: `${getChain(c.chainId).name}: destination ${o.inspection.threshold}-of-${o.inspection.owners.length}`,
        detail: o.issues.length ? o.issues.join(" ") : "Owners and threshold match the live Safe at re-check.",
      });
    }
  }

  items.push({
    id: "receipt",
    kind: "advice",
    title: "Download migration receipt",
    detail: "JSON/PDF commit to what this run planned and verified. This is not an audit certificate.",
    action: "receipt_json",
    primary: summary.outcome === "complete",
  });

  items.push({
    id: "safe-outgoing",
    kind: "unknown",
    title: "Safe outgoing test transaction",
    detail: "Confirm the Safe can execute with your threshold (for example via Safe{Wallet}). This app only records evidence if you add it in the workspace.",
    action: "safe_wallet",
  });

  items.push({
    id: "backup",
    kind: "user_ack",
    title: "Backup saved setup locally",
    detail: "Export your saved Safe profile if you use this browser workspace. Clearing site data removes local records, not onchain assets.",
  });

  items.push({
    id: "revoke",
    kind: "advice",
    title: "Review old wallet approvals",
    detail: "Use a reputable tool such as revoke.cash to revoke token approvals the source wallet granted.",
    action: "revoke_external",
  });

  if (hasRetryable(m)) {
    const primary = items.find((i) => i.primary);
    if (!primary) {
      const first = items.find((i) => i.action === "progress" || i.action === "retry");
      if (first) first.primary = true;
    }
  }

  return items;
}

export function primaryChecklistAction(items: ChecklistItem[]): ChecklistItem | null {
  return (
    items.find((i) => i.primary) ??
    items.find((i) => i.action === "progress") ??
    items.find((i) => i.action === "retry") ??
    items.find((i) => i.action === "receipt_json") ??
    null
  );
}
