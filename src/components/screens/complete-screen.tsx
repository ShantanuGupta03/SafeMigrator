"use client";

import { CheckCircle2, Download, ExternalLink, FileText, Loader2, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getPublicClient } from "@/lib/chains/clients";
import { getChain, safeWalletUrl } from "@/lib/chains/registry";
import { formatAmount, formatFee, sumBigInt, toBigInt } from "@/lib/domain/amounts";
import type { ChainMigration, Migration, NetworkDiscovery, SafeInspection } from "@/lib/domain/types";
import { discoverNetwork, fetchIndexerViaApi, type ManualImport } from "@/lib/services/discovery/asset-discovery";
import { compareSafeToConfig, inspectSafe } from "@/lib/services/onchain-verification";
import { buildReceipt, receiptToJson } from "@/lib/services/receipt";
import { chainOutcome, hasInFlightActions, migrationOutcome, SUCCESS_STATUSES } from "@/lib/state/machine";
import { useAppState } from "../app-state";
import { AddressChip, ChainLabel, downloadFile, ScreenHeading, TxLink } from "../shared";

interface LiveChainResult {
  inspection: SafeInspection | null;
  issues: string[];
  safeHoldings: NetworkDiscovery | null;
  remaining: NetworkDiscovery | null;
  error: string | null;
}

function importsFor(c: ChainMigration, extra: ManualImport[]): ManualImport[] {
  const fromActions: ManualImport[] = c.actions.flatMap((a): ManualImport[] => {
    if (!a.contract) return [];
    if (a.kind === "transfer_erc20") return [{ chainId: c.chainId, standard: "erc20", contract: a.contract, tokenId: null }];
    if (a.kind === "transfer_erc721") return [{ chainId: c.chainId, standard: "erc721", contract: a.contract, tokenId: a.tokenIds[0] ?? null }];
    if (a.kind === "transfer_erc1155") return a.tokenIds.map((id) => ({ chainId: c.chainId, standard: "erc1155" as const, contract: a.contract!, tokenId: id }));
    return [];
  });
  return [...fromActions, ...extra.filter((m) => m.chainId === c.chainId)];
}

/** Build provenance injected by next.config.ts; empty when unknown. */
export function appBuild() {
  return { version: process.env.NEXT_PUBLIC_APP_VERSION || null, commit: process.env.NEXT_PUBLIC_BUILD_COMMIT || null };
}

export function CompleteScreen() {
  const { migration, draft, setStep, startNewMigration } = useAppState();
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; live: Record<number, LiveChainResult>; observedAt: number } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const key = migration ? `${migration.id}:${nonce}` : "";
  const loading = !!migration && result?.key !== key;
  const live = result?.live ?? {};

  const verify = useCallback(async (m: Migration, extra: ManualImport[]) => {
    const entries = await Promise.all(
      m.chains.map(async (c): Promise<[number, LiveChainResult]> => {
        const client = getPublicClient(c.chainId);
        try {
          const imports = importsFor(c, extra);
          const [inspection, safeHoldings, remaining] = await Promise.all([
            inspectSafe(client, c.safeAddress),
            discoverNetwork({ chainId: c.chainId, owner: c.safeAddress, client, manualImports: imports, fetchIndexer: fetchIndexerViaApi }),
            discoverNetwork({ chainId: c.chainId, owner: m.source, client, manualImports: imports, fetchIndexer: fetchIndexerViaApi }),
          ]);
          const issues = inspection.isSafe ? compareSafeToConfig(inspection, m.safeConfig, c.contracts) : ["No Safe deployed at this address."];
          return [c.chainId, { inspection, issues, safeHoldings, remaining, error: null }];
        } catch (e) {
          return [c.chainId, { inspection: null, issues: [], safeHoldings: null, remaining: null, error: (e as Error).message.slice(0, 200) }];
        }
      }),
    );
    return Object.fromEntries(entries) as Record<number, LiveChainResult>;
  }, []);

  useEffect(() => {
    if (!migration) return;
    let cancelled = false;
    void verify(migration, draft.manualImports).then((r) => {
      if (!cancelled) setResult({ key, live: r, observedAt: Date.now() });
    });
    return () => {
      cancelled = true;
    };
    // Re-verify only for a different migration or an explicit request, not on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, verify]);

  if (!migration) {
    return (
      <Alert variant="info" title="No migration to show">
        <Button className="mt-2" onClick={() => setStep("discover")}>
          Back to portfolio
        </Button>
      </Alert>
    );
  }

  const allCompleted = migration.chains.every((c) => chainOutcome(c) === "completed");
  const inFlight = hasInFlightActions(migration);
  const summary = migrationOutcome(migration);
  const scopeTitle =
    summary.outcome === "complete"
      ? "Selected assets migrated"
      : summary.outcome === "partial"
        ? "Partial migration completed"
        : summary.outcome === "uncertain"
          ? "Migration needs reconciliation"
          : allCompleted
            ? "Executed networks finished"
            : "Migration summary";

  const receiptFor = () => {
    const observed = Object.fromEntries(Object.entries(live).map(([id, l]) => [id, { ...l, observedAt: result?.observedAt ?? Date.now() }]));
    return buildReceipt({ migration, generatedAt: Date.now(), app: appBuild(), live: Object.keys(observed).length ? observed : null });
  };
  const exportReceipt = () => {
    const r = receiptFor();
    downloadFile(`safe-migration-${migration.id.slice(0, 8)}.receipt.json`, receiptToJson(r));
  };
  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      const r = receiptFor();
      const { renderReceiptPdf } = await import("@/lib/services/receipt-pdf");
      downloadFile(`safe-migration-${migration.id.slice(0, 8)}.receipt.pdf`, await renderReceiptPdf(r), "application/pdf");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <ScreenHeading
        title={summary.outcome === "complete" && allCompleted ? "Your assets have a safer home." : scopeTitle}
        subtitle={
          summary.outcome === "complete" && allCompleted
            ? "Every asset in your selection was transferred and verified onchain. This is not full wallet retirement — check residual balances below."
            : summary.outcome === "partial"
              ? `${summary.blockedChains} network(s) or ${summary.excludedAssets} asset(s) from your original selection did not migrate. Executed networks are verified below.`
              : summary.outcome === "uncertain"
                ? "At least one step has an unknown submission outcome. Reconcile before retrying any action."
                : "Some networks are not finished. Completed steps are verified onchain; remaining items are listed below."
        }
      />
      {migration.scope && (migration.scope.blockedChains.length > 0 || migration.scope.excludedAssets.length > 0) && (
        <Alert variant="info" title="Original selection vs what ran">
          <p className="text-sm">
            You selected {migration.scope.selectedAssets.length} asset(s) across {migration.scope.selectedChainIds.length} network(s). This run included{" "}
            {migration.scope.includedChainIds.length} network(s).
            {migration.scope.blockedChains.length > 0 && ` Blocked: ${migration.scope.blockedChains.map((b) => getChain(b.chainId).name).join(", ")}.`}
          </p>
        </Alert>
      )}

      {!allCompleted && (
        <Alert variant="warning" title="Incomplete migration">
          At least one network still has pending, failed or rejected steps. Go back to the progress view to resume or retry — confirmed transfers will not be repeated.
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={() => setStep("progress")}>
              Back to progress
            </Button>
          </div>
        </Alert>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => startNewMigration()} disabled={inFlight}>
            <RotateCcw /> Start a new migration
          </Button>
          <Button variant="outline" onClick={exportReceipt}>
            <Download /> Receipt (JSON)
          </Button>
          <Button variant="outline" onClick={() => void exportPdf()} disabled={pdfBusy}>
            {pdfBusy ? <Loader2 className="animate-spin" /> : <FileText />} Receipt (PDF)
          </Button>
          <Button variant="ghost" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-verify onchain
          </Button>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {inFlight
            ? "A transaction is still in flight. Finish it from the progress view before starting a new migration."
            : `A new migration rescans ${shortSource(migration.source)} for assets that arrived since. With the same owners and threshold they go to this Safe, with no new deployment; change either to create a different Safe.`}
        </p>
      </div>

      <div className="grid gap-4">
        {migration.chains.map((c) => (
          <ChainResult key={c.chainId} chain={c} migration={migration} live={live[c.chainId]} loading={loading} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4" /> Security follow-up
          </p>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            <li>
              Confirm you can sign with {migration.safeConfig.threshold} independent owner{migration.safeConfig.threshold === 1 ? "" : "s"} — try a zero-value transaction from
              Safe{"{Wallet}"}.
            </li>
            <li>Back up your recovery arrangements for each owner device, stored separately.</li>
            {migration.safeConfig.owners.some((o) => o.toLowerCase() === migration.source.toLowerCase()) && (
              <li>Your original wallet is still an owner. Consider replacing it with a fresh independent signer from the Safe settings.</li>
            )}
            <li>
              Review and revoke token approvals the old wallet granted (for example with{" "}
              <a className="underline" href="https://revoke.cash" target="_blank" rel="noreferrer">
                revoke.cash
              </a>
              ) and disconnect app integrations.
            </li>
            <li>Avoid using the retired wallet to store significant funds going forward.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function ChainResult({ chain: c, migration, live, loading }: { chain: ChainMigration; migration: Migration; live: LiveChainResult | undefined; loading: boolean }) {
  const meta = getChain(c.chainId);
  const outcome = chainOutcome(c);
  const deploy = c.actions.find((a) => a.kind === "deploy_safe");
  const transfers = c.actions.filter((a) => a.kind !== "deploy_safe");
  const migrated = transfers.filter((a) => a.status === "verified" || a.status === "verified_with_discrepancy");
  const notMigrated = transfers.filter((a) => !SUCCESS_STATUSES.has(a.status) || a.status === "skipped");
  const totalFees = sumBigInt(c.actions.map((a) => toBigInt(a.feePaid)));
  const walletUrl = safeWalletUrl(c.chainId, c.safeAddress);
  const fmtNative = (v: bigint | string) => `${formatFee(v, meta.nativeDecimals)} ${meta.nativeSymbol}`;
  const ownersOk = live?.inspection && live.issues.length === 0;

  return (
    <Card className={outcome === "completed" ? "" : "ring-2 ring-warning/60"}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <ChainLabel chainId={c.chainId} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={outcome === "completed" ? "success" : "warning"}>{outcome === "completed" ? "Completed" : "Incomplete"}</Badge>
          {walletUrl ? (
            <a href={walletUrl} target="_blank" rel="noreferrer">
              <Button size="sm">
                Open in Safe{"{Wallet}"} <ExternalLink />
              </Button>
            </a>
          ) : (
            <Badge variant="outline">Safe{"{Wallet}"} UI not available on {meta.name}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Safe address (v{c.safeVersion})</p>
            <AddressChip address={c.safeAddress} chainId={c.chainId} full className="bg-card" />
            {deploy?.txHash ? (
              <p className="text-xs">
                Deployed in <TxLink chainId={c.chainId} hash={deploy.txHash} />
              </p>
            ) : deploy?.status === "skipped" ? (
              <p className="text-xs text-muted-foreground">Already deployed before this migration.</p>
            ) : null}
          </div>
          <div className="space-y-2 rounded-xl bg-muted p-3">
            <p className="flex items-center justify-between text-xs text-muted-foreground">
              Live owner &amp; threshold check
              {loading && !live ? <Loader2 className="size-3.5 animate-spin" /> : null}
            </p>
            {live?.error && <p className="text-xs text-destructive">Could not read the Safe: {live.error}</p>}
            {live?.inspection && (
              <>
                <p className="flex items-center gap-1.5 font-medium">
                  {ownersOk ? <CheckCircle2 className="size-4 text-success-foreground" /> : <TriangleAlert className="size-4 text-destructive" />}
                  {live.inspection.isSafe ? `${live.inspection.threshold} of ${live.inspection.owners.length} owners` : "Not deployed"}
                  <span className="text-xs font-normal text-muted-foreground">at block {live.inspection.blockNumber}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {live.inspection.owners.map((o) => (
                    <AddressChip key={o} address={o} className="bg-card" />
                  ))}
                </div>
                {live.issues.map((i) => (
                  <p key={i} className="text-xs text-destructive">
                    {i}
                  </p>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 font-medium">Migrated ({migrated.length})</p>
            <ul className="space-y-1">
              {migrated.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {a.label}
                    {a.status === "verified_with_discrepancy" && <Badge variant="warning" className="ml-1">amount differs</Badge>}
                  </span>
                  {a.txHash && <TxLink chainId={c.chainId} hash={a.txHash} />}
                </li>
              ))}
              {migrated.length === 0 && <li className="text-muted-foreground">Nothing transferred yet.</li>}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-medium">Not migrated ({notMigrated.length})</p>
            <ul className="space-y-1">
              {notMigrated.map((a) => (
                <li key={a.id} className="text-muted-foreground">
                  {a.label} — {a.verification?.note ?? a.error?.message ?? a.status.replace("_", " ")}
                </li>
              ))}
              {notMigrated.length === 0 && <li className="text-muted-foreground">None.</li>}
            </ul>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Holdings title="Safe holdings now" d={live?.safeHoldings ?? null} />
          <Holdings title={`Still in ${shortSource(migration.source)}`} d={live?.remaining ?? null} showClass />
        </div>

        <p className="text-xs text-muted-foreground">Network fees paid on {meta.name}: {fmtNative(totalFees)}</p>
      </CardContent>
    </Card>
  );
}

const shortSource = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Holdings({ title, d, showClass }: { title: string; d: NetworkDiscovery | null; showClass?: boolean }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="mb-1 font-medium">{title}</p>
      {!d ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {d.errors.length > 0 && <p className="text-xs text-warning-foreground">Partial read: {d.errors.join(" ")}</p>}
          <ul className="space-y-0.5">
            {d.assets.map((x) => (
              <li key={x.id} className="flex justify-between gap-2">
                <span>
                  {x.standard === "erc721" || x.standard === "erc1155" ? `${x.name} #${x.tokenId}` : x.symbol}
                  {showClass && x.classification !== "transferable" && (
                    <Badge variant="outline" className="ml-1">
                      {x.classification.replace("_", " ")}
                    </Badge>
                  )}
                </span>
                <span className="font-mono text-xs">{x.standard === "erc721" ? "1" : formatAmount(x.balance, x.decimals)}</span>
              </li>
            ))}
            {d.assets.length === 0 && <li className="text-xs text-muted-foreground">No assets found.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
