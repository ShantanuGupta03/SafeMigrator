"use client";

import { CheckCircle2, Circle, Download, ExternalLink, FileText, HelpCircle, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { buildCompletionChecklist, primaryChecklistAction, type ChecklistItem, type ChecklistKind } from "@/lib/services/completion-checklist";
import type { Migration } from "@/lib/domain/types";
import type { LiveObservation } from "@/lib/services/receipt";

const KIND: Record<ChecklistKind, { label: string; variant: "success" | "outline" | "info" | "warning" }> = {
  observed: { label: "Observed", variant: "success" },
  user_ack: { label: "Your acknowledgment", variant: "outline" },
  advice: { label: "Suggested next step", variant: "info" },
  unknown: { label: "Not verified here", variant: "warning" },
};

export function CompletionChecklistPanel(props: {
  migration: Migration;
  live?: Record<number, LiveObservation> | null;
  onProgress?(): void;
  onRetry?(): void;
  onReceiptJson?(): void;
  onReceiptPdf?(): void;
  onSweep?(): void;
}) {
  const items = buildCompletionChecklist(props.migration, props.live);
  const primary = primaryChecklistAction(items);

  return (
    <Card>
      <CardHeader>
        <p className="font-medium">Migration checklist</p>
        <p className="text-sm text-muted-foreground">Facts from this run, separate from suggestions and unchecked items.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {primary && (
          <div className="rounded-xl border border-primary/30 bg-muted/50 p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">Suggested next step</p>
            <p className="font-medium">{primary.title}</p>
            {primary.detail && <p className="mt-1 text-sm text-muted-foreground">{primary.detail}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <ChecklistActionButton item={primary} {...props} />
            </div>
          </div>
        )}
        <ul className="space-y-3">
          {items
            .filter((i) => i !== primary)
            .map((item) => (
              <li key={item.id} className="flex gap-3 text-sm">
                <KindIcon kind={item.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.title}</span>
                    <Badge variant={KIND[item.kind].variant}>{KIND[item.kind].label}</Badge>
                  </div>
                  {item.detail && <p className="mt-0.5 text-muted-foreground">{item.detail}</p>}
                  {item.action && (
                    <div className="mt-2">
                      <ChecklistActionButton item={item} {...props} />
                    </div>
                  )}
                </div>
              </li>
            ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function KindIcon({ kind }: { kind: ChecklistKind }) {
  if (kind === "observed") return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />;
  if (kind === "unknown") return <HelpCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

function ChecklistActionButton(props: {
  item: ChecklistItem;
  onProgress?(): void;
  onRetry?(): void;
  onReceiptJson?(): void;
  onReceiptPdf?(): void;
  onSweep?(): void;
}) {
  const { item } = props;
  switch (item.action) {
    case "progress":
      return (
        <Button size="sm" variant="outline" onClick={props.onProgress}>
          Open progress
        </Button>
      );
    case "retry":
      return (
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          <RotateCcw /> Reconcile / retry
        </Button>
      );
    case "receipt_json":
      return (
        <Button size="sm" variant="outline" onClick={props.onReceiptJson}>
          <Download /> JSON
        </Button>
      );
    case "receipt_pdf":
      return (
        <Button size="sm" variant="outline" onClick={props.onReceiptPdf}>
          <FileText /> PDF
        </Button>
      );
    case "sweep":
      return (
        <Button size="sm" onClick={props.onSweep}>
          <RotateCcw /> New sweep
        </Button>
      );
    case "safe_wallet":
      return (
        <a href="https://app.safe.global" target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost">
            Safe{"{Wallet}"} <ExternalLink />
          </Button>
        </a>
      );
    case "revoke_external":
      return (
        <a href="https://revoke.cash" target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost">
            revoke.cash <ExternalLink />
          </Button>
        </a>
      );
    default:
      return null;
  }
}
