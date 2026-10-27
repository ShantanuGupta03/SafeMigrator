"use client";

import { ArrowLeft, ArrowRight, BadgeCheck, Cpu, KeyRound, Loader2, Plus, Smartphone, UserRound, X } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import type { ChainSafeTarget, SignerKind, SignerSlot } from "@/lib/domain/types";
import { looksLikeEns, MAX_OWNERS, parseAddressInput, resolveEns, signerWarnings, thresholdRisk } from "@/lib/services/signer-configuration";
import { cn, shortAddress } from "@/lib/utils";
import { emptySigner, useAppState } from "../app-state";
import { isCurrentVerification, usePinnedProfile, useSafeConfig, useSafeTargets, useVerifiedOwners } from "../hooks/use-safe-config";
import { OwnerVerificationPanel } from "../owner-verification-panel";
import { AddressChip, ChainLabel, ScreenHeading } from "../shared";

const KIND_META: Record<SignerKind, { label: string; icon: typeof KeyRound; hint: string }> = {
  connected_eoa: { label: "Connected wallet", icon: KeyRound, hint: "The wallet you are migrating from. Consider replacing it later." },
  hardware: { label: "Hardware wallet", icon: Cpu, hint: "Ledger, Trezor, Keystone, GridPlus… keys never leave the device." },
  independent_wallet: { label: "Another wallet", icon: Smartphone, hint: "A separate wallet on a different device or seed phrase." },
  other: { label: "Other signer", icon: UserRound, hint: "A trusted person or another Safe. Make sure they are reachable." },
};

export function describeThreshold(threshold: number, owners: number): string {
  if (owners === 1) return "Your Safe will have a single owner. Add more owners so that one lost or stolen key is not the end of your assets.";
  if (threshold === 1) return `Your Safe will have ${owners} owners, and any one of them can approve a transaction alone.`;
  if (threshold === owners) return `Your Safe will have ${owners} owners, and all ${owners} must approve every transaction.`;
  const lost = owners - threshold;
  const stolen = threshold - 1;
  return (
    `Your Safe will have ${owners} owners. Any ${threshold} of them together can approve a transaction — ` +
    `losing ${lost === 1 ? "one key" : `up to ${lost} keys`} is survivable, and ${stolen === 1 ? "one stolen key is" : `${stolen} stolen keys are`} not enough.`
  );
}

export function SignersScreen() {
  const { draft, setDraft, setStep, source, selection } = useAppState();
  const { config, configHash, issues } = useSafeConfig();
  const verified = useVerifiedOwners();
  const pinnedProfile = usePinnedProfile();
  const chainIds = selection.chainIds;
  const targets = useSafeTargets(config, chainIds);
  const owners = draft.signers.length;
  const warnings = signerWarnings(
    draft.signers.map((s) => ({ ...s, verification: isCurrentVerification(s.verification, configHash, pinnedProfile?.commitment ?? null) ? s.verification : null })),
    source,
    draft.threshold,
  );
  const risk = thresholdRisk(draft.threshold, owners);
  const riskKey = risk ? `${draft.threshold}/${owners}` : null;
  const [acknowledgedRisk, setAcknowledgedRisk] = useState<string | null>(null);
  const riskAccepted = !riskKey || acknowledgedRisk === riskKey;
  const globalIssues = issues.filter((i) => i.slot === null);
  const blockingTarget = Object.values(targets.targets).find((t) => t.status === "deployed_mismatch" || t.status === "incompatible" || t.status === "error");

  const updateSlot = (slot: number, patch: Partial<SignerSlot>) =>
    setDraft((d) => ({ ...d, signers: d.signers.map((s) => (s.slot === slot ? { ...s, ...patch } : s)) }));
  const addSlot = () => setDraft((d) => (d.signers.length >= MAX_OWNERS ? d : { ...d, signers: [...d.signers, emptySigner(d.signers.length)] }));
  const removeSlot = (slot: number) =>
    setDraft((d) => {
      const signers = d.signers
        .filter((s) => s.slot !== slot)
        .map((s, i) => ({ ...s, slot: i, label: s.label === `Signer ${s.slot + 1}` ? `Signer ${i + 1}` : s.label }));
      return { ...d, signers, threshold: Math.min(d.threshold, signers.length) };
    });
  const setThreshold = (threshold: number) => setDraft((d) => ({ ...d, threshold }));

  return (
    <div className="space-y-8">
      <ScreenHeading title="Choose who controls your Safe." subtitle={describeThreshold(draft.threshold, owners)} />

      <ThresholdDiagram signers={draft.signers} verified={verified} threshold={draft.threshold} onThreshold={setThreshold} />

      {risk && (
        <Alert variant="danger" title={`${draft.threshold}-of-${owners} needs your confirmation`}>
          <p>{risk.message}</p>
          <label className="mt-3 flex items-start gap-3 font-medium text-foreground">
            <Checkbox checked={riskAccepted} onChange={(e) => setAcknowledgedRisk(e.target.checked ? riskKey : null)} className="mt-0.5" />
            <span>
              I understand this risk and want a {draft.threshold}-of-{owners} Safe.
            </span>
          </label>
        </Alert>
      )}


      <div className="grid gap-4 lg:grid-cols-3">
        {draft.signers.map((s) => (
          <SignerCard
            key={s.slot}
            signer={s}
            issue={issues.find((i) => i.slot === s.slot)?.message ?? null}
            configHash={configHash}
            onChange={(p) => updateSlot(s.slot, p)}
            onRemove={owners > 1 ? () => removeSlot(s.slot) : undefined}
          />
        ))}
        {owners < MAX_OWNERS && (
          <button
            type="button"
            onClick={addSlot}
            className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-border text-sm font-medium text-muted-foreground transition-colors hover:border-safe-black hover:text-foreground"
          >
            <Plus className="size-5" /> Add owner
          </button>
        )}
      </div>

      <OwnerVerificationPanel
        config={config}
        commonVersion={targets.commonVersion}
        targetsReady={!targets.loading && !targets.error && !blockingTarget}
        scopeChainIds={chainIds.length ? chainIds : chainsForEnvironment(draft.environment).map((c) => c.id)}
      />

      {globalIssues.map((i) => (
        <Alert key={i.code} variant="danger">
          {i.message}
        </Alert>
      ))}

      <div className="grid gap-3">
        {warnings.map((w) => (
          <Alert key={w.message} variant={w.level === "info" ? "info" : "warning"}>
            {w.message}
          </Alert>
        ))}
      </div>

      <Card>
        <CardHeader>
          <p className="font-medium">Your Safe address</p>
          <p className="text-sm text-muted-foreground">
            Predicted with Safe&apos;s Protocol Kit and cross-checked with an independent CREATE2 computation. Nothing is deployed yet.
          </p>
        </CardHeader>
        <CardContent>
          {!config ? (
            <p className="text-sm text-muted-foreground">Enter a valid, distinct address for every owner to predict the address.</p>
          ) : targets.loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Verifying official Safe contracts on each network…
            </p>
          ) : (
            <TargetList targets={chainIds.map((id) => targets.targets[id]).filter(Boolean) as ChainSafeTarget[]} commonVersion={targets.commonVersion} />
          )}
          {targets.error && <Alert variant="danger">{targets.error}</Alert>}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium text-muted-foreground">Advanced</summary>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="text-muted-foreground" htmlFor="salt">
                Safe variant (changes the address for the same owners)
              </label>
              <Input
                id="salt"
                type="number"
                min={0}
                className="w-24"
                value={draft.saltVariant}
                onChange={(e) => setDraft((d) => ({ ...d, saltNonce: null, saltVariant: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
              />
              {draft.saltNonce && <Badge variant="outline">Salt from saved Safe</Badge>}
              {config && <span className="font-mono text-xs text-muted-foreground">saltNonce {config.saltNonce.slice(0, 12)}…</span>}
            </div>
          </details>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 z-10 rounded-2xl bg-card/95 px-4 py-3 shadow-card backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep("discover")}>
            <ArrowLeft /> Back
          </Button>
          <p className="text-sm text-muted-foreground">
            {verified.length}/{owners} owners verified · threshold {draft.threshold} of {owners}
          </p>
          <Button disabled={!config || targets.loading || !!blockingTarget || chainIds.length === 0 || !riskAccepted} onClick={() => setStep("preview")}>
            Review migration <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ThresholdDiagram({
  signers,
  verified,
  threshold,
  onThreshold,
}: {
  signers: SignerSlot[];
  verified: Address[];
  threshold: number;
  onThreshold: (t: number) => void;
}) {
  const v = new Set(verified.map((a) => a.toLowerCase()));
  const owners = signers.length;
  const recommended = owners === 1 ? 1 : Math.floor(owners / 2) + 1;
  return (
    <div className="flex flex-col items-center gap-6 rounded-3xl bg-safe-black p-8 text-safe-white lg:flex-row lg:justify-center lg:gap-12">
      <div className="flex flex-wrap justify-center gap-3">
        {signers.map((s) => {
          const Icon = KIND_META[s.kind].icon;
          const ok = s.address && v.has(s.address.toLowerCase());
          return (
            <div key={s.slot} className="flex flex-col items-center gap-1.5">
              <span className={cn("flex size-14 items-center justify-center rounded-full border-2", s.address ? "border-labs-green" : "border-dashed border-white/25")}>
                <Icon className={cn("size-6", s.address ? "text-labs-green" : "text-white/40")} />
              </span>
              <span className="max-w-20 truncate text-xs text-white/80">{s.label || `Signer ${s.slot + 1}`}</span>
              <span className="text-[10px] text-white/60">{ok ? "verified" : s.address ? "unverified" : "empty"}</span>
            </div>
          );
        })}
      </div>
      <div className="space-y-3 text-center lg:max-w-sm lg:text-left">
        <p className="text-special font-medium text-labs-green">
          {threshold} of {owners}
        </p>
        <p className="max-w-64 text-sm text-white/70">signatures required for every transaction from your Safe.</p>
        <div role="radiogroup" aria-label="Signatures required" className="flex flex-wrap justify-center gap-1.5 lg:justify-start">
          {Array.from({ length: owners }, (_, i) => i + 1).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={t === threshold}
              aria-label={`${t} of ${owners}`}
              onClick={() => onThreshold(t)}
              className={cn(
                "size-9 cursor-pointer rounded-xl text-sm font-medium transition-colors",
                t === threshold ? "bg-labs-green text-safe-black" : "bg-white/10 text-white/80 hover:bg-white/20",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-xs text-white/50">
          Default is 2 of 3. {owners > 1 && `Recommended for ${owners} owners: ${recommended}.`} Changing owners or the threshold changes the Safe address and needs owners to verify again.
        </p>
      </div>
    </div>
  );
}

function SignerCard({
  signer,
  issue,
  configHash,
  onChange,
  onRemove,
}: {
  signer: SignerSlot;
  issue: string | null;
  configHash: `0x${string}` | null;
  onChange: (p: Partial<SignerSlot>) => void;
  onRemove?: () => void;
}) {
  const { source } = useAppState();
  const pinned = usePinnedProfile();
  const { address: connected } = useConnection();
  const [resolving, setResolving] = useState(false);
  const meta = KIND_META[signer.kind];
  const isVerified = isCurrentVerification(signer.verification, configHash, pinned?.commitment ?? null);
  const connectedMatches = !!connected && !!signer.address && connected.toLowerCase() === signer.address.toLowerCase();

  const commitInput = async (raw: string) => {
    const v = raw.trim();
    const addr = parseAddressInput(v);
    if (addr) return onChange({ input: v, address: addr, ensName: null, verification: null });
    if (looksLikeEns(v)) {
      setResolving(true);
      const resolved = await resolveEns(v, getPublicClient(1));
      setResolving(false);
      return onChange({ input: v, address: resolved, ensName: resolved ? v : null, verification: null });
    }
    onChange({ input: v, address: null, ensName: null, verification: null });
  };

  return (
    <Card className={cn(isVerified ? "ring-2 ring-labs-green" : connectedMatches && configHash && "ring-2 ring-safe-black")}>
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-medium">
            <meta.icon className="size-4" /> Signer {signer.slot + 1}
          </span>
          <span className="flex items-center gap-1">
            {isVerified ? (
              <Badge variant="success">
                <BadgeCheck className="size-3" /> Verified {signer.verification!.signerType === "contract" ? "(ERC-1271)" : ""}
              </Badge>
            ) : (
              <Badge variant="warning">Unverified</Badge>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove signer ${signer.slot + 1}`}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </span>
        </div>
        <Select
          value={signer.kind}
          aria-label="Signer type"
          onChange={(e) => {
            const kind = e.target.value as SignerKind;
            onChange({ kind, label: signer.label === KIND_META[signer.kind].label ? KIND_META[kind].label : signer.label });
          }}
        >
          {Object.entries(KIND_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{meta.hint}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="0x… or name.eth"
          defaultValue={signer.input}
          key={signer.input}
          aria-label={`Signer ${signer.slot + 1} address`}
          aria-invalid={!!issue}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v !== signer.input && parseAddressInput(v)) void commitInput(v);
          }}
          onBlur={(e) => void commitInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void commitInput((e.target as HTMLInputElement).value)}
        />
        <Input
          placeholder="Label (e.g. Ledger in safe)"
          className="font-sans"
          value={signer.label}
          aria-label={`Signer ${signer.slot + 1} label`}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        {signer.kind === "connected_eoa" && source && signer.address?.toLowerCase() !== source.toLowerCase() && (
          <Button variant="outline" size="sm" onClick={() => void commitInput(source)}>
            Use connected wallet ({shortAddress(source)})
          </Button>
        )}
        {resolving && <p className="text-xs text-muted-foreground">Resolving ENS…</p>}
        {signer.ensName && signer.address && (
          <p className="text-xs text-muted-foreground">
            {signer.ensName} → <span className="font-mono">{shortAddress(signer.address)}</span>
          </p>
        )}
        {signer.address && !issue && <AddressChip address={signer.address} full />}
        {issue && signer.input && <p className="text-xs font-medium text-destructive">{issue}</p>}

        {signer.address && !isVerified && (
          <p className="text-xs text-muted-foreground">Not verified yet. Use “Verify owners” below to sign here or send this owner an invitation.</p>
        )}
      </CardContent>
    </Card>
  );
}

function TargetList({ targets, commonVersion }: { targets: ChainSafeTarget[]; commonVersion: string | null }) {
  const addresses = new Set(targets.map((t) => t.predictedAddress).filter(Boolean));
  return (
    <div className="space-y-3">
      {addresses.size === 1 && targets.length > 1 && (
        <Alert variant="success" title="Same Safe address on every selected network">
          Using Safe v{commonVersion} canonical contracts (L2 singleton) on all networks.
        </Alert>
      )}
      {addresses.size > 1 && (
        <Alert variant="warning" title="Different addresses per network">
          Not every network supports the same Safe deployment. Each network&apos;s address is listed separately — double-check before sending funds manually.
        </Alert>
      )}
      <div className="divide-y divide-border rounded-xl border border-border">
        {targets.map((t) => (
          <div key={t.chainId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <ChainLabel chainId={t.chainId} />
            <div className="flex flex-wrap items-center gap-2">
              {t.predictedAddress && <AddressChip address={t.predictedAddress} chainId={t.chainId} />}
              {t.safeVersion && <Badge variant="outline">v{t.safeVersion}</Badge>}
              <TargetStatus t={t} />
            </div>
            {t.issues.length > 0 && <p className="w-full text-xs text-muted-foreground">{t.issues.join(" ")}</p>}
          </div>
        ))}
      </div>
      {targets.length === 0 && <p className="text-sm text-muted-foreground">Select assets on at least one network.</p>}
      <p className="text-xs text-muted-foreground">
        A Safe only exists on networks where it has been deployed. Never send funds to this address on a network where it is not yet deployed and verified.
      </p>
    </div>
  );
}

export function TargetStatus({ t }: { t: ChainSafeTarget }) {
  switch (t.status) {
    case "not_deployed":
      return <Badge variant="outline">Will be deployed</Badge>;
    case "deployed_matching":
      return <Badge variant="success">Already deployed · config verified</Badge>;
    case "deployed_governance_changed":
      return <Badge variant="warning">Deployed · governance changed</Badge>;
    case "deployed_mismatch":
      return <Badge variant="danger">Conflicting contract</Badge>;
    case "incompatible":
      return <Badge variant="danger">Incompatible network</Badge>;
    default:
      return <Badge variant="danger">{t.unavailable ? "Network unreachable" : "Verification error"}</Badge>;
  }
}
