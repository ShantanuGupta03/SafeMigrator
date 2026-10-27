"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { explorerAddressUrl, explorerTxUrl, getChain } from "@/lib/chains/registry";
import { cn, shortAddress } from "@/lib/utils";
import type { Step } from "./app-state";

export function ChainIcon({ chainId, size = 28 }: { chainId: number; size?: number }) {
  const c = getChain(chainId);
  const initials = c.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: c.color, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  );
}

export function ChainLabel({ chainId, className }: { chainId: number; className?: string }) {
  const c = getChain(chainId);
  return (
    <span className={cn("inline-flex items-center gap-2 font-medium", className)}>
      <ChainIcon chainId={chainId} size={22} />
      {c.name}
      {c.environment === "testnet" && <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase text-muted-foreground">testnet</span>}
    </span>
  );
}

export function AddressChip({ address, chainId, full = false, className }: { address: string; chainId?: number; full?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 rounded-lg bg-muted px-2 py-1 font-mono text-xs", className)}>
      <span className={cn(full ? "break-all" : "truncate")} title={address}>
        {full ? address : shortAddress(address, 6)}
      </span>
      <button
        type="button"
        aria-label="Copy address"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {chainId !== undefined && (
        <a href={explorerAddressUrl(chainId, address)} target="_blank" rel="noreferrer" aria-label="Open in explorer" className="text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </span>
  );
}

export function TxLink({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  return (
    <a href={explorerTxUrl(chainId, hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline">
      {label ?? shortAddress(hash, 6)}
      <ExternalLink className="size-3" />
    </a>
  );
}

const STEPS: { key: Step; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "discover", label: "Portfolio" },
  { key: "signers", label: "Signers" },
  { key: "preview", label: "Review" },
  { key: "progress", label: "Migrate" },
  { key: "complete", label: "Done" },
];

export function Stepper({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex items-center gap-0.5 overflow-x-auto rounded-2xl bg-card p-1 text-sm shadow-card" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.key}>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-medium whitespace-nowrap",
              i < idx && "text-foreground",
              i === idx && "bg-primary text-primary-foreground",
              i > idx && "text-muted-foreground",
            )}
            aria-current={i === idx ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-[11px]",
                i < idx ? "bg-labs-green text-safe-black" : i === idx ? "bg-safe-green text-safe-black" : "bg-muted",
              )}
            >
              {i < idx ? <Check className="size-3" /> : i + 1}
            </span>
            <span className="hidden lg:inline">{s.label}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Text wordmark. The official Safe logomark must be used exactly as supplied in the brand kit, so it
 * is not redrawn here.
 */
export function AppWordmark({ className }: { className?: string }) {
  return <span className={cn("text-lead font-medium whitespace-nowrap", className)}>Safe Migrator</span>;
}

/** Screen title on the Safe H2 scale: 40/120 Medium (40/44 Regular on mobile), 18/28 supporting copy. */
export function ScreenHeading({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) {
  return (
    <div className="space-y-4 pb-2 md:pb-8">
      <h1 className="text-h2 leading-[44px] font-normal md:leading-[120%] md:font-medium">{title}</h1>
      {subtitle && <p className="max-w-2xl text-lead text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/** Saves text as a file in the browser. Nothing leaves the device. */
export function downloadFile(filename: string, content: string | Uint8Array, type = "application/json") {
  const blob = new Blob([content as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads a user-chosen file as text, refusing anything larger than `maxBytes`. */
export async function readFileText(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) throw new Error(`File is larger than ${Math.round(maxBytes / 1024)} KB.`);
  return file.text();
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
