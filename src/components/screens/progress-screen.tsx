"use client";

import { AlertTriangle, Check, CircleDashed, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { useConnection } from "wagmi";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getChain } from "@/lib/chains/registry";
import { formatAmount, formatFee } from "@/lib/domain/amounts";
import type { ActionStatus, ChainMigration, ChainPhase, MigrationAction } from "@/lib/domain/types";
import { chainOutcome, hasRetryable, migrationProgress, type ChainOutcome } from "@/lib/state/machine";
import { cn } from "@/lib/utils";
import { useAppState } from "../app-state";
import { useRunner } from "../hooks/use-runner";
import { AddressChip, ChainLabel, ScreenHeading, TxLink } from "../shared";

const TIMELINE: { phase: ChainPhase; label: string }[] = [
  { phase: "waiting_wallet", label: "Waiting for wallet" },
  { phase: "deploying_safe", label: "Deploying Safe" },
  { phase: "verifying_safe", label: "Verifying Safe" },
  { phase: "preparing_transfers", label: "Preparing transfers" },
  { phase: "awaiting_approval", label: "Awaiting transaction approval" },
  { phase: "transferring", label: "Transferring assets" },
  { phase: "confirming", label: "Confirming transfers" },
  { phase: "verifying_balances", label: "Verifying balances" },
  { phase: "completed", label: "Completed" },
];

const ACTION_STATUS: Record<ActionStatus, { label: string; variant: "default" | "success" | "warning" | "danger" | "outline" | "info" }> = {
  planned: { label: "Queued", variant: "outline" },
  awaiting_wallet: { label: "Confirm in wallet", variant: "info" },
  submitted: { label: "Submitted", variant: "info" },
  verifying: { label: "Verifying onchain", variant: "info" },
  verified: { label: "Verified", variant: "success" },
  verified_with_discrepancy: { label: "Verified (amount differs)", variant: "warning" },
  skipped: { label: "Skipped", variant: "outline" },
  rejected: { label: "Rejected in wallet", variant: "warning" },
  failed: { label: "Failed", variant: "danger" },
  needs_attention: { label: "Needs attention", variant: "warning" },
  uncertain: { label: "Outcome unknown", variant: "warning" },
};

const OUTCOME: Record<ChainOutcome, { label: string; variant: "default" | "success" | "warning" | "danger" | "outline" | "info" }> = {
  not_started: { label: "Not started", variant: "outline" },
  in_progress: { label: "In progress", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  needs_attention: { label: "Needs attention", variant: "warning" },
  blocked: { label: "Blocked", variant: "danger" },
};

export function ProgressScreen() {
  const { migration, dispatch, setStep, discardMigration } = useAppState();
  const { address } = useConnection();
  const runner = useRunner();
  if (!migration) {
    return (
      <Alert variant="info" title="No migration in progress">
        <Button className="mt-2" onClick={() => setStep("discover")}>
          Back to portfolio
        </Button>
      </Alert>
    );
  }
  const progress = migrationProgress(migration);
  const wrongAccount = !address || address.toLowerCase() !== migration.source.toLowerCase();
  const retryable = hasRetryable(migration);
  const awaitingWallet = migration.chains.some((c) => c.actions.some((a) => a.status === "awaiting_wallet"));
  const stoppedOnRejection = !runner.running && migration.chains.some((c) => c.actions.some((a) => a.status === "rejected"));

  const resume = () => void runner.start();
  const retry = () => {
    dispatch({ type: "RETRY_FAILED" });
    void runner.start();
  };

  return (
    <div className="space-y-8">
      <ScreenHeading
        title="Securing your assets."
        subtitle="Each network runs on its own. Keep this tab open and approve each request in your wallet; progress is saved after every step."
      />

      {migration.chains.some((c) => c.actions.some((a) => a.error?.code === "insufficient_gas")) && (
        <Alert variant="warning" title="Source wallet needs more native balance for gas">
          <p className="text-sm">
            Send native coin to <AddressChip address={migration.source} className="bg-card" /> on the affected network, then use Retry. Your reviewed amounts and destination are unchanged; exact transfers are not reduced automatically.
          </p>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {progress.done} of {progress.total} steps complete
              {progress.attention > 0 && ` · ${progress.attention} need attention`}
            </p>
            <div className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <p className="text-sm font-medium">
              {runner.running
                ? runner.stopping
                  ? "Pausing after the current step…"
                  : awaitingWallet
                    ? "Waiting for your confirmation in the wallet."
                    : "Running…"
                : progress.complete
                  ? "All steps complete."
                  : "Stopped. Nothing is being sent right now."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {runner.running ? (
              <Button variant="outline" onClick={runner.pause} disabled={runner.stopping}>
                <Pause /> Pause after this step
              </Button>
            ) : (
              <>
                {!progress.complete && (
                  <Button onClick={resume} disabled={wrongAccount}>
                    <Play /> Resume
                  </Button>
                )}
                {retryable && (
                  <Button variant="outline" onClick={retry} disabled={wrongAccount}>
                    <RotateCcw /> Retry failed actions
                  </Button>
                )}
                <Button variant={progress.complete ? "default" : "ghost"} onClick={() => setStep("complete")}>
                  {progress.complete ? "View results" : "View summary"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {wrongAccount && !runner.running && (
        <Alert variant="warning" title="Connect the source wallet to continue">
          This migration belongs to <span className="font-mono">{migration.source}</span>. Switch to that account to resume.
        </Alert>
      )}
      {stoppedOnRejection && (
        <Alert variant="warning" title="A wallet request was rejected">
          The migration stopped at the rejected step. Steps already confirmed onchain are kept. Choose <b>Retry failed actions</b> to ask again.
        </Alert>
      )}

      <div className="grid gap-4">
        {migration.chains.map((c) => (
          <ChainProgress key={c.chainId} chain={c} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <p className="font-medium">Activity log</p>
        </CardHeader>
        <CardContent>
          <ol className="max-h-72 space-y-1 overflow-y-auto font-mono text-xs">
            {[...migration.log].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className={cn(e.level === "error" && "text-destructive", e.level === "warn" && "text-warning-foreground")}>
                <span className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span>{" "}
                {e.chainId !== null && <span className="font-medium">[{getChain(e.chainId).shortName}]</span>} {e.message}{" "}
                {e.txHash && e.chainId !== null && <TxLink chainId={e.chainId} hash={e.txHash} />}
              </li>
            ))}
            {migration.log.length === 0 && <li className="text-muted-foreground">No activity yet.</li>}
          </ol>
        </CardContent>
      </Card>

      {!runner.running && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (window.confirm("Discard this migration record? Onchain transactions are not affected, but the saved progress will be lost.")) {
                discardMigration();
                setStep("discover");
              }
            }}
          >
            Discard saved progress
          </Button>
        </div>
      )}
    </div>
  );
}

function ChainProgress({ chain }: { chain: ChainMigration }) {
  const outcome = chainOutcome(chain);
  const currentIdx = TIMELINE.findIndex((t) => t.phase === chain.phase);
  const halted = chain.phase === "failed" || chain.phase === "needs_attention";
  return (
    <Card className={cn(halted && "ring-2 ring-warning/60")}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <ChainLabel chainId={chain.chainId} />
        <div className="flex flex-wrap items-center gap-2">
          <AddressChip address={chain.safeAddress} chainId={chain.chainId} />
          <Badge variant="outline">{chain.strategy === "atomic_batch" ? "Atomic batch" : "Sequential"}</Badge>
          <Badge variant={OUTCOME[outcome].variant}>{OUTCOME[outcome].label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {TIMELINE.map((t, i) => {
            const done = outcome === "completed" || (currentIdx >= 0 && i < currentIdx);
            const active = !halted && i === currentIdx && outcome !== "completed";
            return (
              <li key={t.phase} className={cn("flex items-center gap-1.5", done ? "text-foreground" : active ? "font-medium text-foreground" : "text-muted-foreground")}>
                {done ? <Check className="size-3.5 text-success-foreground" /> : active ? <Loader2 className="size-3.5 animate-spin" /> : <CircleDashed className="size-3.5" />}
                {t.label}
              </li>
            );
          })}
          {halted && (
            <li className="flex items-center gap-1.5 font-medium text-destructive">
              {chain.phase === "failed" ? <X className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
              {chain.phase === "failed" ? "Failed" : "Needs attention"}
            </li>
          )}
        </ol>
        {chain.message && (
          <Alert variant={halted ? "warning" : "info"}>
            {chain.message}
          </Alert>
        )}
        <div className="divide-y divide-border rounded-xl border border-border">
          {chain.actions.map((a) => (
            <ActionRow key={a.id} action={a} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ActionRow({ action: a }: { action: MigrationAction }) {
  const chain = getChain(a.chainId);
  const s = ACTION_STATUS[a.status];
  const amount =
    a.kind === "transfer_native" || a.kind === "transfer_erc20"
      ? `${formatAmount(a.amounts[0] ?? "0", a.decimals)} ${a.symbol}`
      : a.kind === "transfer_erc1155"
        ? a.tokenIds.map((id, i) => `#${id}×${a.amounts[i] ?? "?"}`).join(", ")
        : a.kind === "transfer_erc721"
          ? `#${a.tokenIds[0]}`
          : null;
  return (
    <div className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {a.label} {amount && <span className="text-muted-foreground">· {amount}</span>}
        </span>
        <span className="flex items-center gap-2">
          {a.txHash && <TxLink chainId={a.chainId} hash={a.txHash} />}
          {a.feePaid && <span className="text-xs text-muted-foreground">fee {formatFee(a.feePaid, chain.nativeDecimals)} {chain.nativeSymbol}</span>}
          <Badge variant={s.variant}>{s.label}</Badge>
        </span>
      </div>
      {a.error && <p className="text-xs text-destructive">{a.error.message}</p>}
      {a.verification?.note && <p className="text-xs text-muted-foreground">{a.verification.note}</p>}
    </div>
  );
}
