"use client";

import { FileText, FileUp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getPublicClient } from "@/lib/chains/clients";
import { findChain } from "@/lib/chains/registry";
import { formatAmount, formatFee } from "@/lib/domain/amounts";
import { inspectSafe } from "@/lib/services/onchain-verification";
import { inspectReceipt, outcomeHeadline, RECEIPT_MAX_BYTES, type InspectResult, type Receipt } from "@/lib/services/receipt";
import { AddressChip, ChainLabel, downloadFile, readFileText, ScreenHeading, TxLink } from "../shared";

type TxCheck = { status: "success" | "reverted" | "not_found" | "error"; block: string | null };
type Recheck = {
  checkedAt: number;
  chains: Record<number, { owners: string[]; threshold: number; isSafe: boolean; block: string } | { error: string }>;
  txs: Record<string, TxCheck>;
};

/**
 * Offline receipt inspector. Loading a file validates its schema and recomputes its integrity hash
 * locally; it never contacts a URL from the file and never touches a wallet. An explicit "Recheck
 * onchain" reads the listed transactions and Safes through this app's read-only RPC proxy, for
 * supported networks only, and shows the result separately from the record.
 */
export function ReceiptInspector() {
  const [result, setResult] = useState<InspectResult | null>(null);
  const [pasted, setPasted] = useState("");
  const [recheck, setRecheck] = useState<Recheck | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (text: string) => {
    setRecheck(null);
    setResult(inspectReceipt(text));
  };

  const runRecheck = async (r: Receipt) => {
    setBusy(true);
    const chains: Recheck["chains"] = {};
    const txs: Recheck["txs"] = {};
    for (const c of r.record.chains) {
      if (!findChain(c.chainId)) continue;
      const client = getPublicClient(c.chainId);
      try {
        const insp = await inspectSafe(client, c.safeAddress);
        chains[c.chainId] = { owners: insp.owners, threshold: insp.threshold, isSafe: insp.isSafe, block: insp.blockNumber };
      } catch (e) {
        chains[c.chainId] = { error: (e as Error).message.slice(0, 160) };
      }
      const hashes = [c.deployment.txHash, ...c.actions.map((a) => a.txHash)].filter((h): h is `0x${string}` => !!h);
      for (const hash of [...new Set(hashes)]) {
        try {
          const receipt = await client.getTransactionReceipt({ hash });
          txs[`${c.chainId}:${hash}`] = { status: receipt.status === "success" ? "success" : "reverted", block: receipt.blockNumber.toString() };
        } catch (e) {
          const notFound = /not be found|not found/i.test((e as Error).message);
          txs[`${c.chainId}:${hash}`] = { status: notFound ? "not_found" : "error", block: null };
        }
      }
    }
    setRecheck({ checkedAt: Date.now(), chains, txs });
    setBusy(false);
  };

  return (
    <div className="space-y-8">
      <ScreenHeading
        title="Inspect a migration receipt."
        subtitle="Checks a receipt file on this device: its format and its integrity hash. Nothing is uploaded. Checking the chain is a separate, explicit step."
      />
      <Card>
        <CardContent className="space-y-3 p-6">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => fileRef.current?.click()}>
              <FileUp /> Open receipt JSON
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) load(await readFileText(f, RECEIPT_MAX_BYTES).catch((err: Error) => `{"error":${JSON.stringify(err.message)}}`));
              }}
            />
          </div>
          <textarea
            className="min-h-24 w-full rounded-xl border border-border bg-card p-2 font-mono text-xs"
            placeholder="…or paste the receipt JSON here"
            aria-label="Receipt JSON"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={!pasted.trim()} onClick={() => load(pasted)}>
            Inspect pasted receipt
          </Button>
        </CardContent>
      </Card>

      {result && !result.ok && <Alert variant="danger" title="Not a valid receipt">{result.reason}</Alert>}
      {result?.ok && <ReceiptView result={result} recheck={recheck} busy={busy} onRecheck={() => void runRecheck(result.receipt)} />}
    </div>
  );
}

function ReceiptView({ result, recheck, busy, onRecheck }: { result: Extract<InspectResult, { ok: true }>; recheck: Recheck | null; busy: boolean; onRecheck(): void }) {
  const r = result.receipt;
  const head = outcomeHeadline(r);
  const exportPdf = async () => {
    const { renderReceiptPdf } = await import("@/lib/services/receipt-pdf");
    downloadFile(`safe-migration-${r.record.migrationId.slice(0, 8)}.receipt.pdf`, await renderReceiptPdf(r), "application/pdf");
  };
  return (
    <div className="space-y-4">
      {result.hashMatches ? (
        <Alert variant="success" title="Integrity hash matches">
          The content is exactly what was exported (SHA-256 over canonical JSON, <span className="font-mono">{r.integrity.hash.slice(0, 18)}…</span>). This is a commitment, not a
          signature: it shows the file was not edited, not who made it or that it is true. Use “Recheck onchain” to compare it with the chain.
        </Alert>
      ) : (
        <Alert variant="danger" title="Integrity hash does NOT match">
          The file was edited after it was exported, or it is corrupted. Recomputed <span className="font-mono">{result.recomputed.slice(0, 18)}…</span>, file states{" "}
          <span className="font-mono">{r.integrity.hash.slice(0, 18)}…</span>. Do not rely on its contents.
        </Alert>
      )}
      <Alert variant={head.tone} title={head.title}>
        {r.record.outcomeScope}
      </Alert>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <p className="font-medium">
            Run {r.record.migrationId} · {r.record.environment} · generated {new Date(r.generatedAt).toLocaleString()}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onRecheck} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Recheck onchain
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportPdf()} disabled={!result.hashMatches} title={result.hashMatches ? undefined : "Only receipts whose hash matches can be printed"}>
              <FileText /> PDF
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-2 md:grid-cols-2">
            <p>
              Source <AddressChip address={r.record.source} />
            </p>
            <p>
              Owners {r.record.destination.threshold} of {r.record.destination.owners.length} · commitment{" "}
              <span className="font-mono text-xs">{r.record.destination.deploymentCommitment?.slice(0, 14) ?? "unknown"}</span>
            </p>
          </div>
          {r.record.retention && (
            <Alert variant="info" title="Gas retention (recorded at migration)">
              Optional post-migration buffer was {r.record.retention.optionalGasBuffer ? "enabled" : "disabled"} on at least one network. Mandatory execution reserve is always separate.
            </Alert>
          )}
          {r.record.scope === null && <Alert variant="warning">This record predates scope tracking: blocked networks and excluded assets are unknown.</Alert>}
          {r.record.scope?.blockedChains.map((b) => (
            <Alert key={b.chainId} variant="warning" title={`Not migrated: ${findChain(b.chainId)?.name ?? b.chainId}`}>
              {b.reasons.join(" ")}
            </Alert>
          ))}
          {r.record.chains.map((c) => {
            const now = recheck?.chains[c.chainId];
            return (
              <div key={c.chainId} className="space-y-2 rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ChainLabel chainId={c.chainId} />
                  <span className="flex flex-wrap items-center gap-2">
                    <AddressChip address={c.safeAddress} chainId={c.chainId} />
                    <Badge variant={c.outcome === "completed" ? "success" : "warning"}>{c.outcome.replace(/_/g, " ")}</Badge>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Recorded: {c.verifiedAtMigration ? `${c.verifiedAtMigration.threshold} of ${c.verifiedAtMigration.owners.length} owners at block ${c.verifiedAtMigration.blockNumber}` : "verification unknown"} · fees{" "}
                  {formatFee(c.fees.paidRaw, c.nativeDecimals)} {c.nativeSymbol}
                </p>
                {now && (
                  <p className="text-xs">
                    <span className="font-medium">Now (live): </span>
                    {"error" in now ? `could not read (${now.error})` : now.isSafe ? `${now.threshold} of ${now.owners.length} owners at block ${now.block}` : "no Safe at this address"}
                  </p>
                )}
                <ul className="space-y-2">
                  {c.actions.map((a) => {
                    const tx = a.txHash ? recheck?.txs[`${c.chainId}:${a.txHash}`] : undefined;
                    const intent =
                      a.amounts.intentMode === "exact" && a.amounts.requestedRaw?.length
                        ? `exact ${formatAmount(BigInt(a.amounts.requestedRaw[0] ?? "0"), a.decimals)} ${a.symbol}`
                        : a.amounts.intentMode === "max" && a.amounts.reviewedCeilingRaw
                          ? `max ≤ ${formatAmount(BigInt(a.amounts.reviewedCeilingRaw), a.decimals)} ${a.symbol}`
                          : null;
                    return (
                      <li key={a.id} className="space-y-0.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {a.label} <Badge variant={a.status === "verified" || a.status === "skipped" ? "outline" : "warning"}>{a.status.replace(/_/g, " ")}</Badge>
                          </span>
                          <span className="flex items-center gap-2">
                            {a.txHash && <TxLink chainId={c.chainId} hash={a.txHash} />}
                            {tx && (
                              <Badge variant={tx.status === "success" ? "success" : "danger"}>
                                {tx.status === "success" ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />} {tx.status.replace("_", " ")}
                              </Badge>
                            )}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {intent && <span>{intent} · </span>}
                          planned {a.display.planned || a.amounts.plannedRaw.join(", ")} raw
                          {a.amounts.verifiedDeltaRaw && ` · verified Δ ${formatAmount(BigInt(a.amounts.verifiedDeltaRaw), a.decimals)}`}
                          {a.amounts.sourceRemainingRaw && ` · source left ${formatAmount(BigInt(a.amounts.sourceRemainingRaw), a.decimals)}`}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {recheck && <p className="text-xs text-muted-foreground">Live checks at {new Date(recheck.checkedAt).toLocaleString()} through this app&apos;s read-only RPC proxy. They are not part of the receipt.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
