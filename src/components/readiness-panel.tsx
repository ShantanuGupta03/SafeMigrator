"use client";

import { CheckCircle2, CircleDashed, ExternalLink, HelpCircle, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Hex } from "viem";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { getChain, safeWalletUrl } from "@/lib/chains/registry";
import type { GovernanceSnapshot, SafeProfile } from "@/lib/domain/profile";
import { inspectSafe } from "@/lib/services/onchain-verification";
import { assessReadiness, verifyOutgoingSafeTx, type CheckState } from "@/lib/services/readiness";
import { canonicalContractSet } from "@/lib/services/safe-deployment";
import { isPinned, snapshotFromInspection, withSnapshot } from "@/lib/services/safe-profile";
import { safeConfigHash } from "@/lib/services/signer-configuration";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";
import { isCurrentVerification } from "./hooks/use-safe-config";

const STATE_META: Record<CheckState, { label: string; icon: typeof CheckCircle2; className: string }> = {
  observed: { label: "Observed onchain", icon: CheckCircle2, className: "text-success-foreground" },
  acknowledged: { label: "Acknowledged by you (not observed)", icon: CircleDashed, className: "text-warning-foreground" },
  attention: { label: "Needs attention", icon: TriangleAlert, className: "text-warning-foreground" },
  unknown: { label: "Unknown", icon: HelpCircle, className: "text-muted-foreground" },
  missing: { label: "Not yet", icon: CircleDashed, className: "text-muted-foreground" },
};

/** Factual readiness of a saved Safe: what was observed, acknowledged or is still unknown. */
export function ReadinessPanel({ profile, onUpdate }: { profile: SafeProfile; onUpdate(fn: (p: SafeProfile) => SafeProfile): void }) {
  const { draft } = useAppState();
  const [balances, setBalances] = useState<Record<number, bigint | null>>({});
  const [busy, setBusy] = useState(false);
  const deployedChains = profile.deployments.map((d) => d.chainId);
  const [chainId, setChainId] = useState<number | null>(deployedChains[0] ?? null);
  const [txHash, setTxHash] = useState("");
  const [evidenceMsg, setEvidenceMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const verifiedOwners = useMemo(() => {
    const hash = safeConfigHash(profile.original);
    return draft.signers.filter((s) => s.address && isCurrentVerification(s.verification, hash, profile.commitment)).map((s) => s.address!);
  }, [draft.signers, profile.original, profile.commitment]);
  const items = assessReadiness({ profile, verifiedOwners, safeNativeBalances: balances });

  if (!isPinned(profile)) return null;
  const address = profile.safeAddress;
  const version = profile.recipe.safeVersion;

  const refresh = async () => {
    setBusy(true);
    const snapshots: GovernanceSnapshot[] = [];
    const out: Record<number, bigint | null> = {};
    for (const id of deployedChains) {
      const client = getPublicClient(id);
      try {
        snapshots.push(snapshotFromInspection(id, await inspectSafe(client, address), profile.original, canonicalContractSet(version)));
      } catch {
        // Kept as the previous (stale) observation.
      }
      out[id] = await client.getBalance({ address }).catch(() => null);
    }
    setBalances(out);
    onUpdate((cur) => snapshots.reduce<SafeProfile>((p, s) => withSnapshot(p, s), cur));
    setBusy(false);
  };

  const addEvidence = async () => {
    if (!chainId) return;
    setEvidenceMsg(null);
    const r = await verifyOutgoingSafeTx({ client: getPublicClient(chainId), chainId, safe: address, txHash: txHash.trim() as Hex });
    if (!r.ok) return setEvidenceMsg({ ok: false, text: r.reason });
    onUpdate((cur) => ({ ...cur, readiness: { ...cur.readiness, outgoing: [...cur.readiness.outgoing.filter((e) => e.txHash !== r.evidence.txHash), r.evidence] } }));
    setTxHash("");
    setEvidenceMsg({ ok: true, text: `Recorded: executed by the Safe with threshold ${r.evidence.thresholdAtBlock}.` });
  };

  const walletLink = chainId ? safeWalletUrl(chainId, address) : null;
  return (
    <div className="space-y-3 rounded-xl bg-muted p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" /> Safe readiness
        </p>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy || deployedChains.length === 0}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check readiness
        </Button>
      </div>
      <ul className="space-y-2">
        {items.map((i) => {
          const meta = STATE_META[i.state];
          return (
            <li key={i.key} className="rounded-lg bg-card p-2 text-sm">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <meta.icon className={cn("size-4", meta.className)} /> {i.title} <span className={cn("text-xs font-normal", meta.className)}>{meta.label}</span>
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-xs text-muted-foreground">
                {i.detail.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {deployedChains.length > 0 && (
        <div className="space-y-2 rounded-lg bg-card p-2 text-sm">
          <p className="font-medium">Prove the Safe works: a small outgoing transaction</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>Open the Safe in Safe{"{Wallet}"} and create a small transaction (for example, send a tiny amount back to one of the owners).</li>
            <li>Collect the required owner signatures from the owners&apos; own devices, then execute it.</li>
            <li>Paste the execution transaction hash below. It counts only if this Safe itself executed it successfully.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={chainId ?? ""} aria-label="Evidence network" onChange={(e) => setChainId(Number(e.target.value))}>
              {deployedChains.map((id) => (
                <option key={id} value={id}>
                  {getChain(id).name}
                </option>
              ))}
            </Select>
            <Input className="w-full max-w-md text-xs" placeholder="0x… transaction hash" value={txHash} onChange={(e) => setTxHash(e.target.value)} aria-label="Outgoing transaction hash" />
            <Button size="sm" onClick={() => void addEvidence()} disabled={!txHash.trim()}>
              Verify and record
            </Button>
            {walletLink && (
              <a className="inline-flex items-center gap-1 text-xs underline" href={walletLink} target="_blank" rel="noreferrer">
                Open in Safe{"{Wallet}"} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          {evidenceMsg && <Alert variant={evidenceMsg.ok ? "success" : "danger"}>{evidenceMsg.text}</Alert>}
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={!!profile.readiness.acknowledgedTestTransaction}
              onChange={(e) => onUpdate((cur) => ({ ...cur, readiness: { ...cur.readiness, acknowledgedTestTransaction: e.target.checked ? Date.now() : null } }))}
              className="mt-0.5"
            />
            <span>I executed a test transaction elsewhere and do not have its hash. (Shown as your acknowledgement, not as observed evidence.)</span>
          </label>
        </div>
      )}
    </div>
  );
}
