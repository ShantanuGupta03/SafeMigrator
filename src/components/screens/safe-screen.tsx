"use client";

import { ArrowLeft, Download, FolderOpen, Loader2, RefreshCw, ShieldCheck, Upload, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { getChain, safeWalletUrl } from "@/lib/chains/registry";
import type { SafeProfile } from "@/lib/domain/profile";
import { inspectSafe } from "@/lib/services/onchain-verification";
import { canonicalContractSet } from "@/lib/services/safe-deployment";
import {
  exportProfile,
  governanceByChain,
  importProfile,
  isPinned,
  PROFILE_IMPORT_MAX_BYTES,
  profileTitle,
  recoverLegacyProfile,
  snapshotFromInspection,
  withSnapshot,
} from "@/lib/services/safe-profile";
import { cn } from "@/lib/utils";
import { useAppState } from "../app-state";
import { AddressChip, ChainLabel, downloadFile, readFileText, ScreenHeading, timeAgo, TxLink } from "../shared";

/**
 * The migration workspace: saved Safes for the connected source, their pinned identity, and the
 * per-network state observed onchain. Actions here never send transactions by themselves; anything
 * that moves assets goes through the normal Review step.
 */
export function SafeScreen() {
  const { profiles, profileIssues, source, draft, setStep, saveProfile, selectProfile, activeProfile } = useAppState();
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const visible = profiles.filter((p) => p.environment === draft.environment);

  const onImport = async (file: File | undefined) => {
    setImportError(null);
    if (!file || !source) return;
    try {
      const r = importProfile(await readFileText(file, PROFILE_IMPORT_MAX_BYTES), { source, environment: draft.environment });
      if (!r.ok) return setImportError(r.reason);
      const clash = profiles.find((p) => p.id === r.profile.id || (p.commitment && p.commitment === r.profile.commitment));
      if (clash) return setImportError(`This Safe is already saved (${profileTitle(clash)}).`);
      saveProfile(r.profile);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-8">
      <ScreenHeading
        title="Your saved Safes."
        subtitle="Each saved Safe keeps its exact deployment recipe, so new networks, sweeps and later runs always target the same address. Everything is stored in this browser only."
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setStep("discover")}>
          <ArrowLeft /> Back to portfolio
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload /> Import profile
        </Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onImport(e.target.files?.[0])} />
      </div>
      {importError && <Alert variant="danger" title="Import rejected">{importError}</Alert>}
      {profileIssues.length > 0 && (
        <Alert variant="warning" title={`${profileIssues.length} stored profile(s) failed validation`}>
          They are kept in storage untouched and are not used: {profileIssues.map((i) => i.reason).join(" ")}
        </Alert>
      )}
      {visible.length === 0 && (
        <Alert variant="info" title="No saved Safe yet">
          A Safe is saved automatically when you start a migration or invite owners to verify. You can also import a profile exported from another browser.
        </Alert>
      )}
      <div className="grid gap-4">
        {visible.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            active={activeProfile?.id === p.id}
            onUse={() => {
              selectProfile(p.id);
              setStep("discover");
            }}
            onSave={saveProfile}
          />
        ))}
      </div>
    </div>
  );
}

function ProfileCard({ profile: p, active, onUse, onSave }: { profile: SafeProfile; active: boolean; onUse(): void; onSave(p: SafeProfile, replaces?: string[]): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState(p.label ?? "");
  const pinned = isPinned(p);
  const governance = governanceByChain(p);

  const refresh = async () => {
    if (!isPinned(p)) return;
    const address = p.safeAddress;
    const version = p.recipe.safeVersion;
    setBusy("refresh");
    setError(null);
    let next: SafeProfile = p;
    const failures: string[] = [];
    for (const d of p.deployments) {
      try {
        const insp = await inspectSafe(getPublicClient(d.chainId), address);
        next = withSnapshot(next, snapshotFromInspection(d.chainId, insp, p.original, canonicalContractSet(version)));
      } catch (e) {
        failures.push(`${getChain(d.chainId).name}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    onSave(next);
    if (failures.length) setError(`Could not read: ${failures.join(" · ")}. Their last observation is kept and marked stale.`);
    setBusy(null);
  };

  const recover = async () => {
    setBusy("recover");
    setError(null);
    const r = await recoverLegacyProfile(p, getPublicClient);
    if (r.ok) onSave(r.profile);
    else setError(r.reason);
    setBusy(null);
  };

  return (
    <Card className={cn(active && "ring-2 ring-safe-black")}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-lead font-medium">
            {profileTitle(p)}
            <ProfileStatusBadge profile={p} />
            {active && <Badge variant="dark">In use</Badge>}
          </p>
          <p className="text-sm text-muted-foreground">
            {p.original.threshold} of {p.original.owners.length} original owners · created {new Date(p.createdAt).toLocaleDateString()} · {p.runIds.length} run(s)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {pinned && (
            <Button size="sm" onClick={onUse} disabled={active}>
              <FolderOpen /> {active ? "Selected" : "Use this Safe"}
            </Button>
          )}
          {p.status === "needs_recovery" && (
            <Button size="sm" onClick={() => void recover()} disabled={!!busy}>
              {busy === "recover" ? <Loader2 className="animate-spin" /> : <Wrench />} Recover from chain
            </Button>
          )}
          {pinned && (
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={!!busy || p.deployments.length === 0}>
              {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-read governance
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => downloadFile(`safe-profile-${p.id.slice(0, 8)}.json`, exportProfile(p))}>
            <Download /> Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <Alert variant="warning">{error}</Alert>}
        {p.status === "needs_recovery" && p.legacy && (
          <Alert variant="info" title="Created from records before saved Safes existed">
            {p.legacy.reason} Recovery re-derives the recipe from the official contracts and checks that it reproduces the recorded address on every recorded network. Nothing is
            guessed: if that fails, the old runs stay viewable as history only.
          </Alert>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Safe address (every network)</p>
            {p.safeAddress ? <AddressChip address={p.safeAddress} full className="bg-card" /> : <p className="text-muted-foreground">Unknown until recovered</p>}
            {p.recipe && (
              <p className="text-xs text-muted-foreground">
                Pinned recipe: Safe v{p.recipe.safeVersion} (L2 singleton), canonical factory, commitment <span className="font-mono">{p.commitment?.slice(0, 14)}…</span>
              </p>
            )}
          </div>
          <div className="space-y-2 rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Original owners (sorted)</p>
            <div className="flex flex-wrap gap-1">
              {p.original.owners.map((o) => (
                <AddressChip key={o} address={o} className="bg-card" />
              ))}
            </div>
          </div>
        </div>

        <div>
          <p className="mb-2 font-medium">Networks</p>
          {governance.length === 0 ? (
            <p className="text-muted-foreground">Not deployed on any network yet.</p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {governance.map((g) => {
                const dep = p.deployments.find((d) => d.chainId === g.chainId);
                const url = p.safeAddress ? safeWalletUrl(g.chainId, p.safeAddress) : null;
                return (
                  <div key={g.chainId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <ChainLabel chainId={g.chainId} />
                    <div className="flex flex-wrap items-center gap-2">
                      <GovernanceBadge state={g.state} stale={g.stale} />
                      {g.snapshot && (
                        <span className="text-xs text-muted-foreground">
                          {g.snapshot.threshold} of {g.snapshot.owners.length} · block {g.snapshot.blockNumber} · {timeAgo(g.snapshot.observedAt)}
                        </span>
                      )}
                      {dep?.txHash && <TxLink chainId={g.chainId} hash={dep.txHash} label="deployment" />}
                      {dep?.how === "legacy_record" && <Badge variant="outline">from old record</Badge>}
                      {url && (
                        <a className="text-xs underline" href={url} target="_blank" rel="noreferrer">
                          Safe{"{Wallet}"}
                        </a>
                      )}
                    </div>
                    {g.state === "diverged" && g.snapshot && <p className="w-full text-xs text-warning-foreground">{g.snapshot.issues.join(" ")}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Private label (stays on this device; never in shareable receipts)
            <Input className="w-64 font-sans" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <Button size="sm" variant="ghost" onClick={() => onSave({ ...p, label: label.trim() || null, updatedAt: Date.now() })} disabled={(p.label ?? "") === label.trim()}>
            Save label
          </Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Every action re-reads the chain. Stored observations are shown with their block and age; they never authorize anything.
        </p>
      </CardContent>
    </Card>
  );
}

export function ProfileStatusBadge({ profile }: { profile: SafeProfile }) {
  if (profile.status === "needs_recovery") return <Badge variant="warning">Needs recovery</Badge>;
  if (profile.status === "proposed") return <Badge variant="outline">Proposed · not deployed</Badge>;
  return <Badge variant="success">Pinned</Badge>;
}

function GovernanceBadge({ state, stale }: { state: string; stale: boolean }) {
  const label =
    state === "matches_original" ? "Original owners" : state === "diverged" ? "Governance changed" : state === "not_deployed" ? "No Safe found" : "Not yet observed";
  const variant = state === "matches_original" ? "success" : state === "diverged" ? "warning" : "outline";
  return (
    <span className="flex items-center gap-1">
      <Badge variant={variant}>{label}</Badge>
      {stale && state !== "unknown" && <Badge variant="outline">stale</Badge>}
    </span>
  );
}
