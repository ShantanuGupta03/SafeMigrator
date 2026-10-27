"use client";

import { ArrowLeft, Layers, ListOrdered, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConnection } from "wagmi";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment, getChain } from "@/lib/chains/registry";
import { formatAmount, formatFee } from "@/lib/domain/amounts";
import type { DiscoveredAsset, ExecutionStrategy, ExpectedGovernance } from "@/lib/domain/types";
import {
  assembleChainPlan,
  buildActions,
  createMigration,
  needsDeploymentFor,
  preflightChain,
  type ChainPlan,
  type ChainPreflight,
} from "@/lib/services/migration-planning";
import { buildMigrationScope, requiresPartialAck } from "@/lib/services/migration-scope";
import { chooseProfileForRun, expectedGovernanceFrom, pinRecipe, profileTitle } from "@/lib/services/safe-profile";
import { getAtomicCapabilities, type ChainCapability, type Eip1193Requester } from "@/lib/services/transaction-capability";
import { selectionKey } from "@/lib/services/selection";
import { safeConfigHash } from "@/lib/services/signer-configuration";
import { useAppState } from "../app-state";
import { useRunner } from "../hooks/use-runner";
import { isCurrentVerification, usePinnedProfile, useSafeConfig, useSafeTargets, useVerifiedOwners } from "../hooks/use-safe-config";
import { AddressChip, ChainLabel, ScreenHeading } from "../shared";
import { TargetStatus } from "./signers-screen";

const PREFLIGHT_MAX_AGE_MS = 30 * 60 * 1000;

export function PreviewScreen() {
  const { draft, discovery, selection, setStep, source, dispatch, profiles, saveProfile, setDraft, activeProfile } = useAppState();
  const pinnedProfile = usePinnedProfile();
  const [starting, setStarting] = useState(false);
  const [acceptedGovernance, setAcceptedGovernance] = useState<Record<number, string>>({});
  const { address, connector, chainId: walletChainId } = useConnection();
  const { config } = useSafeConfig();
  const verified = useVerifiedOwners();
  const runner = useRunner();
  const [refresh, setRefresh] = useState(0);
  const chainIds = selection.chainIds;
  const selectedAssets = selection.assets;
  const targets = useSafeTargets(config, chainIds, refresh);
  const [preflight, setPreflight] = useState<{
    inputs: unknown[];
    capabilities: Record<number, ChainCapability>;
    preflights: Record<number, ChainPreflight>;
    plannedAt: number;
  } | null>(null);
  const [overrides, setOverrides] = useState<Record<number, ExecutionStrategy>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [partialAck, setPartialAck] = useState(false);

  // Preflight: capabilities + simulations + gas estimates (all real RPC / wallet calls).
  const ready = !!config && !!source && chainIds.length > 0 && !targets.loading && Object.keys(targets.targets).length > 0;
  const inputs = useMemo(
    () => [config, source, targets, chainIds, selectionKey(selection), connector, refresh],
    [config, source, targets, chainIds, selection, connector, refresh],
  );
  const fresh = preflight !== null && preflight.inputs === inputs;
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const loading = ready && !fresh;
  const capabilities = fresh ? preflight.capabilities : {};
  const preflights = useMemo(() => (fresh ? preflight.preflights : {}), [fresh, preflight]);

  useEffect(() => {
    if (!config || !source || targets.loading || Object.keys(targets.targets).length === 0) return;
    let cancelled = false;
    (async () => {
      let caps: Record<number, ChainCapability> = {};
      if (connector) {
        try {
          const provider = (await connector.getProvider()) as Eip1193Requester;
          caps = await getAtomicCapabilities(provider, source, chainIds);
        } catch {
          caps = {};
        }
      }
      const entries = await Promise.all(
        chainIds.map(async (id) => {
          const target = targets.targets[id]!;
          const actions = buildActions(id, selectedAssets, needsDeploymentFor(target));
          const pre = await preflightChain({ client: getPublicClient(id), source, config, target, actions, capability: caps[id] });
          return [id, pre] as const;
        }),
      );
      if (!cancelled) setPreflight({ inputs, capabilities: caps, preflights: Object.fromEntries(entries), plannedAt: Date.now() });
    })();
    return () => {
      cancelled = true;
    };
  }, [inputs, config, source, targets, chainIds, selectedAssets, connector]);

  const plans: ChainPlan[] = useMemo(
    () =>
      chainIds
        .filter((id) => preflights[id])
        .map((id) =>
          assembleChainPlan(preflights[id]!, buildActions(id, selectedAssets, needsDeploymentFor(targets.targets[id])), {
            verifiedOwnerCount: verified.length,
            threshold: draft.threshold,
            strategyOverride: overrides[id],
            walletChainId,
            governanceAccepted: governanceKey(targets.targets[id]) !== null && acceptedGovernance[id] === governanceKey(targets.targets[id]),
          }),
        ),
    [chainIds, preflights, selectedAssets, targets.targets, verified.length, draft.threshold, overrides, walletChainId, acceptedGovernance],
  );
  const threshold = config?.threshold ?? draft.threshold;
  const ownerCount = config?.owners.length ?? draft.signers.length;

  const executable = plans.filter((p) => p.executable);
  const anyCombined = executable.some((p) => p.confirmations.deploymentInBatch);
  const totalConfirmations = executable.reduce((s, p) => s + p.confirmations.total, 0);
  const unsupported = useMemo(() => {
    const out: DiscoveredAsset[] = [];
    for (const id of chainsForEnvironment(draft.environment).map((c) => c.id)) {
      for (const a of discovery[id]?.assets ?? []) if (a.classification !== "transferable" && a.classification !== "suspicious") out.push(a);
    }
    return out;
  }, [discovery, draft.environment]);
  const wrongAccount = !address || !source || address.toLowerCase() !== source.toLowerCase();
  const scopePreview = useMemo(
    () =>
      buildMigrationScope({
        selection,
        selectedChainIds: draft.selectedChains,
        plans,
        discovery,
        partialAcknowledged: partialAck,
        plannedAt: preflight?.plannedAt ?? 0,
      }),
    [selection, draft.selectedChains, plans, discovery, partialAck, preflight?.plannedAt],
  );
  const needsPartialAck = requiresPartialAck(scopePreview);
  const ownerProofs = useMemo(
    () =>
      draft.signers
        .filter((s) => s.address && config && isCurrentVerification(s.verification, safeConfigHash(config), pinnedProfile?.commitment ?? null))
        .map((s) => ({ owner: s.address!, verification: s.verification! })),
    [draft.signers, config, pinnedProfile?.commitment],
  );

  const start = async () => {
    setMigrateError(null);
    if (!config || !source || !fresh) return;
    if (needsPartialAck && !partialAck) return;
    if (Date.now() - preflight!.plannedAt > PREFLIGHT_MAX_AGE_MS) {
      setMigrateError("Preflight is older than 30 minutes. Click Re-check, then migrate again.");
      return;
    }
    const execPlans = plans.filter((p) => p.executable);
    if (execPlans.length === 0) return;
    setStarting(true);
    try {
      // Pin the deployment identity before anything is sent; later runs reuse it verbatim.
      let profile = pinnedProfile;
      if (!profile) {
        const version = targets.commonVersion;
        if (!version) throw new Error("No Safe version is shared by every network of this environment, so the address cannot be pinned.");
        const first = execPlans[0]!.chainId;
        const pin = await pinRecipe(getPublicClient(first), first, config, version);
        const chosen = chooseProfileForRun({ profiles, source, environment: draft.environment, config, pinned: pin });
        profile = chosen.profile;
        saveProfile(profile, chosen.replaces);
      }
      const different = execPlans.filter((p) => p.safeAddress !== profile!.safeAddress || p.safeVersion !== profile!.recipe!.safeVersion);
      if (different.length) {
        throw new Error(
          `${different.map((p) => getChain(p.chainId).name).join(", ")} would use a different Safe address than the saved Safe. Deselect ${different.length > 1 ? "those networks" : "that network"} to continue.`,
        );
      }
      const expectedGovernance: Record<number, ExpectedGovernance> = {};
      for (const p of execPlans) {
        const t = targets.targets[p.chainId];
        if (t?.status === "deployed_governance_changed" && t.inspection) expectedGovernance[p.chainId] = expectedGovernanceFrom(t.inspection);
      }
      const scope = buildMigrationScope({
        selection,
        selectedChainIds: draft.selectedChains,
        plans,
        discovery,
        partialAcknowledged: partialAck,
        plannedAt: preflight!.plannedAt,
      });
      setDraft((d) => ({ ...d, profileId: profile!.id }));
      dispatch({
        type: "CREATE",
        migration: createMigration({
          id: crypto.randomUUID(),
          source,
          environment: draft.environment,
          safeConfig: config,
          verifiedOwners: verified,
          ownerProofs,
          scope,
          plans,
          profileId: profile.id,
          deploymentCommitment: profile.commitment,
          purpose: profile.runIds.length > 0 ? "sweep" : "migration",
          expectedGovernance,
        }),
      });
      setStep("progress");
      void runner.start();
    } catch (e) {
      setMigrateError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const changedGovernance = plans
    .map((p) => targets.targets[p.chainId])
    .filter((t): t is NonNullable<typeof t> => t?.status === "deployed_governance_changed");

  return (
    <div className="space-y-8">
      <ScreenHeading title="Everything ready for the move?" subtitle="Review every detail. Nothing happens until you approve each step in your wallet." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Source wallet" value={source ? <AddressChip address={source} /> : "—"} />
        <Stat label="Threshold" value={`${threshold} of ${ownerCount} owner${ownerCount === 1 ? "" : "s"}`} />
        <Stat label="Networks" value={`${executable.length} of ${plans.length} ready`} />
        <Stat
          label="Wallet confirmations"
          value={loading ? "…" : `${totalConfirmations} prompt${totalConfirmations === 1 ? "" : "s"}`}
          hint="Includes network switches, deployments and transfers. Signatures for owner verification are separate."
        />
      </div>

      <Card>
        <CardHeader>
          <p className="font-medium">Owners</p>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          {config?.owners.map((o) => {
            const slot = draft.signers.find((s) => s.address?.toLowerCase() === o.toLowerCase());
            const isVerified = verified.some((v) => v.toLowerCase() === o.toLowerCase());
            return (
              <div key={o} className="space-y-1 rounded-xl bg-muted p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{slot?.label || "Owner"}</span>
                  <Badge variant={isVerified ? "success" : "warning"}>{isVerified ? "Verified" : "Unverified"}</Badge>
                </div>
                <AddressChip address={o} className="bg-card" />
                {source && o.toLowerCase() === source.toLowerCase() && <p className="text-xs text-warning-foreground">Source wallet stays an owner</p>}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {(loading || targets.loading) && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Simulating transactions and estimating gas on each network…
        </p>
      )}
      {migrateError && (
        <Alert variant="warning" title="Cannot start yet">
          {migrateError}
        </Alert>
      )}
      {ready && !fresh && (
        <Alert variant="warning" title="Preflight is stale">
          Selection or network conditions changed. Click Re-check before migrating.
        </Alert>
      )}
      {needsPartialAck && (
        <Alert variant="warning" title="Not everything in your selection can migrate">
          <ul className="mt-1 list-disc pl-5 text-sm">
            {scopePreview.blockedChains.map((b) => (
              <li key={b.chainId}>
                {getChain(b.chainId).name}: {b.reasons.join(" ")}
              </li>
            ))}
            {scopePreview.excludedAssets.slice(0, 6).map((a) => (
              <li key={a.assetId}>
                {a.label} on {getChain(a.chainId).name}: {a.reason}
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox checked={partialAck} onChange={(e) => setPartialAck(e.target.checked)} className="mt-0.5" />
            <span>I understand only {executable.length} network(s) will run now. Blocked items stay in my wallet until I fix them and start a new migration.</span>
          </label>
        </Alert>
      )}

      <Alert variant="info" title={pinnedProfile ? `Saved Safe: ${profileTitle(pinnedProfile)}` : "A saved Safe will be created"}>
        {pinnedProfile ? (
          <span>
            Destination fixed by the saved deployment recipe (Safe v{pinnedProfile.recipe!.safeVersion}, commitment{" "}
            <span className="font-mono">{pinnedProfile.commitment!.slice(0, 10)}…</span>). The version is not renegotiated, so the address cannot change.
          </span>
        ) : (
          <span>
            {activeProfile && !pinnedProfile
              ? "These owners, threshold or salt differ from your saved Safe, so this creates a different Safe. "
              : ""}
            Starting pins this Safe&apos;s deployment recipe so later runs, sweeps and new networks reuse exactly the same address.
          </span>
        )}
      </Alert>

      {changedGovernance.map((t) => (
        <Alert key={t.chainId} variant="warning" title={`${getChain(t.chainId).name}: the Safe's governance changed since it was deployed`}>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {t.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          {t.inspection && (
            <p className="mt-2 text-sm">
              Current: {t.inspection.threshold} of {t.inspection.owners.length} owners at block {t.inspection.blockNumber}. Assets sent here can be moved by the current owners,
              not necessarily the owners you originally chose.
            </p>
          )}
          {getChain(t.chainId).environment === "mainnet" ? (
            <p className="mt-2 font-medium text-destructive">
              Production networks require owner proofs for the current owners, which this version cannot collect for changed governance. This network is blocked.
            </p>
          ) : (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <Checkbox
                checked={acceptedGovernance[t.chainId] === governanceKey(t)}
                onChange={(e) => setAcceptedGovernance((a) => ({ ...a, [t.chainId]: e.target.checked ? (governanceKey(t) ?? "") : "" }))}
                className="mt-0.5"
              />
              <span>I reviewed the current owners and settings above and want to send assets to this Safe. Execution stops if anything changes again before sending.</span>
            </label>
          )}
        </Alert>
      ))}

      <div className="grid gap-4">
        {plans.map((p) => (
          <PlanCard
            key={p.chainId}
            plan={p}
            capability={capabilities[p.chainId]}
            onStrategy={(s) => setOverrides((o) => ({ ...o, [p.chainId]: s }))}
            targetStatus={targets.targets[p.chainId]}
          />
        ))}
      </div>

      {unsupported.length > 0 && (
        <Card>
          <CardHeader>
            <p className="font-medium">Not included: positions that need other tools</p>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {unsupported.map((a) => (
              <p key={a.id}>
                <span className="font-medium">{a.symbol}</span> on {getChain(a.chainId).name} — <span className="text-muted-foreground">{a.reasons.join(" ") || a.classification}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Alert variant="info" title="How this migration executes">
        {anyCombined
          ? "On networks marked as one batch, the Safe deployment and every token transfer go out in a single all-or-nothing transaction: if the deployment fails, nothing moves. The Safe's owners and threshold are verified onchain right after, and only then is the remaining native balance sent as a final transaction sized from your actual balance. "
          : "On each network the Safe is deployed first and its owners and threshold are verified onchain, then assets are transferred. "}
        Networks are never atomic with each other — if one network fails, the others keep their progress and you can retry.
      </Alert>

      <Card className="ring-1 ring-safe-black">
        <CardContent className="space-y-4 p-5">
          <label className="flex items-start gap-3 text-sm">
            <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>
              I have reviewed the destination Safe address on each network, the {ownerCount} owner{ownerCount === 1 ? "" : "s"} and the {threshold}-of-{ownerCount} threshold, the
              networks and assets included, and the estimated fees. I control at least {threshold} of the owners and understand that assets sent to the Safe can only be moved with{" "}
              {threshold} owner signature{threshold === 1 ? "" : "s"}.
            </span>
          </label>
          {wrongAccount && <Alert variant="warning">Connect the source wallet ({source}) to start.</Alert>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep("signers")}>
                <ArrowLeft /> Back
              </Button>
              <Button variant="outline" onClick={() => setRefresh((r) => r + 1)} disabled={loading}>
                <RefreshCw /> Re-check
              </Button>
            </div>
            <Button
              size="lg"
              disabled={!confirmed || !fresh || executable.length === 0 || loading || wrongAccount || runner.running || starting || (needsPartialAck && !partialAck)}
              onClick={() => void start()}
            >
              <ShieldCheck /> Migrate to Safe
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Identifies one reviewed observation; a newer observation needs a new acceptance. */
function governanceKey(t: { status: string; inspection: { blockNumber: string } | null; chainId: number } | undefined): string | null {
  if (!t || t.status !== "deployed_governance_changed" || !t.inspection) return null;
  return `${t.chainId}:${t.inspection.blockNumber}`;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-3xl bg-card p-6 shadow-card" title={hint}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2 text-h3 font-medium">{value}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PlanCard({
  plan,
  capability,
  onStrategy,
  targetStatus,
}: {
  plan: ChainPlan;
  capability: ChainCapability | undefined;
  onStrategy: (s: ExecutionStrategy) => void;
  targetStatus: Parameters<typeof TargetStatus>[0]["t"] | undefined;
}) {
  const chain = getChain(plan.chainId);
  const fmt = (v: bigint) => `${formatAmount(v, chain.nativeDecimals, 6)} ${chain.nativeSymbol}`;
  const fmtFee = (v: bigint) => `${formatFee(v, chain.nativeDecimals)} ${chain.nativeSymbol}`;
  const batchAvailable = capability?.atomic === "supported" || capability?.atomic === "ready";
  return (
    <Card className={plan.executable ? "" : "ring-2 ring-destructive/40"}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <ChainLabel chainId={plan.chainId} />
        <div className="flex flex-wrap items-center gap-2">
          {plan.safeAddress && <AddressChip address={plan.safeAddress} chainId={plan.chainId} />}
          {plan.safeVersion && <Badge variant="outline">Safe v{plan.safeVersion}</Badge>}
          {targetStatus && <TargetStatus t={targetStatus} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Execution</p>
            <p className="flex items-center gap-1.5 font-medium">
              {plan.strategy === "atomic_batch" ? <Layers className="size-4" /> : <ListOrdered className="size-4" />}
              {plan.strategy === "atomic_batch" ? "Atomic batch (EIP-5792)" : "One transaction at a time"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {batchAvailable
                ? `Wallet reports atomic batching: ${capability!.atomic}.`
                : (capability?.note ?? "Wallet does not report atomic batching for this network.")}
            </p>
            {batchAvailable && (
              <button className="mt-1 text-xs font-medium underline" onClick={() => onStrategy(plan.strategy === "atomic_batch" ? "sequential" : "atomic_batch")}>
                {plan.strategy === "atomic_batch" ? "Use one-by-one instead" : "Use atomic batch"}
              </button>
            )}
          </div>
          <div className="rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Wallet confirmations</p>
            <p className="font-medium">{plan.confirmations.total}</p>
            <p className="text-xs text-muted-foreground">
              {(() => {
                const native = plan.actions.some((a) => a.kind === "transfer_native" && a.status === "planned");
                const tokenBatch = plan.strategy === "atomic_batch" && plan.confirmations.transfers > (native ? 1 : 0);
                return [
                  plan.confirmations.chainSwitch && "1 network switch",
                  plan.confirmations.deployment && "1 Safe deployment",
                  plan.strategy === "atomic_batch"
                    ? tokenBatch && (plan.confirmations.deploymentInBatch ? "1 batch: Safe deployment + token transfers" : "1 token transfer batch")
                    : plan.confirmations.transfers && `${plan.confirmations.transfers} transfer transaction${plan.confirmations.transfers > 1 ? "s" : ""}`,
                  plan.strategy === "atomic_batch" && native && `1 ${chain.nativeSymbol} transfer (sized after the batch)`,
                ];
              })()
                .filter(Boolean)
                .join(" · ") || "Nothing to sign"}
            </p>
            {plan.confirmations.note && <p className="text-xs text-muted-foreground">{plan.confirmations.note}</p>}
          </div>
          <div className="rounded-xl bg-muted p-3">
            <p className="text-xs text-muted-foreground">Estimated network fees</p>
            <p className="font-medium">≈ {fmtFee(plan.costs.totalTypical)}</p>
            <p className="text-xs text-muted-foreground">
              Up to {fmtFee(plan.costs.totalMax)} reserved (deployment {fmtFee(plan.costs.deployMax)}, transfers {fmtFee(plan.costs.transfersMax)}).
            </p>
          </div>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border text-sm">
          {plan.actions.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="font-medium">{a.label}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {a.kind === "transfer_native" || a.kind === "transfer_erc20"
                  ? `${formatAmount(a.amounts[0] ?? "0", a.decimals)} ${a.symbol}`
                  : a.kind === "transfer_erc1155"
                    ? a.tokenIds.map((id, i) => `#${id}×${a.amounts[i]}`).join(", ")
                    : a.kind === "transfer_erc721"
                      ? `#${a.tokenIds[0]}`
                      : ""}
                {a.status === "skipped" && <Badge variant="outline">{a.verification?.note ?? "Skipped"}</Badge>}
                {a.feeEstimate && a.status === "planned" && <span className="text-xs">fee ≤ {fmtFee(BigInt(a.feeEstimate))}</span>}
              </span>
            </div>
          ))}
        </div>

        {plan.nativeBalance !== null && (
          <p className="text-xs text-muted-foreground">
            Native balance {fmt(plan.nativeBalance)} · reserved for gas {fmtFee(plan.nativeReserve)}
            {plan.nativeToSend !== null && ` · ${fmt(plan.nativeToSend)} moves last, recalculated right before sending`}
          </p>
        )}

        {plan.excluded.map((e) => (
          <Alert key={e.action.id} variant="warning" title={`${e.action.label} — cannot be transferred`}>
            {e.reason} This asset is excluded and will stay in your wallet.
          </Alert>
        ))}
        {plan.blockers.map((b) => (
          <Alert key={b} variant="danger">
            {b}
          </Alert>
        ))}
        {plan.warnings.map((w) => (
          <Alert key={w} variant="info">
            {w}
          </Alert>
        ))}
      </CardContent>
    </Card>
  );
}
