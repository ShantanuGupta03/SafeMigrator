"use client";

import { Loader2, Network, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useConnection } from "wagmi";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment, getChain } from "@/lib/chains/registry";
import { formatAmount, formatFee } from "@/lib/domain/amounts";
import type { SafeProfile } from "@/lib/domain/profile";
import { applyAssessment, assessExtension, type ExtensionAssessment } from "@/lib/services/chain-extension";
import { assembleChainPlan, buildActions, createMigration, needsDeploymentFor, preflightChain, type ChainPlan } from "@/lib/services/migration-planning";
import { isPinned } from "@/lib/services/safe-profile";
import { safeConfigHash } from "@/lib/services/signer-configuration";
import { useAppState } from "./app-state";
import { isCurrentVerification } from "./hooks/use-safe-config";
import { useRunner } from "./hooks/use-runner";
import { TargetStatus } from "./screens/signers-screen";

/**
 * Deploys a saved Safe on another network using ONLY its pinned recipe, or records a matching
 * Safe that already exists there. Every check re-reads the chain; the deployment itself goes
 * through the normal executor (simulation, gas reserve, receipt tracking, onchain verification).
 */
export function AddNetworkPanel({ profile, onUpdate }: { profile: SafeProfile; onUpdate(fn: (p: SafeProfile) => SafeProfile): void }) {
  const { draft, setDraft, dispatch, setStep, source } = useAppState();
  const { address, chainId: walletChainId } = useConnection();
  const runner = useRunner();
  const options = chainsForEnvironment(profile.environment).filter((c) => !profile.deployments.some((d) => d.chainId === c.id));
  const [chainId, setChainId] = useState<number | null>(options[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [assessment, setAssessment] = useState<ExtensionAssessment | null>(null);
  const [plan, setPlan] = useState<ChainPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSource = !!address && !!source && address.toLowerCase() === profile.source.toLowerCase();

  if (!isPinned(profile)) return null;
  if (options.length === 0) return <p className="text-xs text-muted-foreground">Recorded on every network of this environment.</p>;

  const check = async () => {
    if (!chainId) return;
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const a = await assessExtension({ profile, chainId, clientFor: getPublicClient });
      setAssessment(a);
      onUpdate((cur) => applyAssessment(cur, { ...a, action: a.action === "reuse" ? "blocked" : a.action }));
      if (a.action === "deploy") {
        const client = getPublicClient(chainId);
        const actions = buildActions(chainId, [], needsDeploymentFor(a.target));
        const pre = await preflightChain({ client, source: profile.source, config: profile.original, target: a.target, actions, capability: undefined });
        setPlan(assembleChainPlan(pre, actions, { verifiedOwnerCount: proofs().length, threshold: profile.original.threshold, walletChainId }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const proofs = () => {
    const hash = safeConfigHash(profile.original);
    return draft.signers.filter((s) => s.address && isCurrentVerification(s.verification, hash, profile.commitment)).map((s) => ({ owner: s.address!, verification: s.verification! }));
  };

  const deploy = () => {
    if (!plan?.executable || !assessment) return;
    setDraft((d) => ({ ...d, profileId: profile.id }));
    const ownerProofs = proofs();
    dispatch({
      type: "CREATE",
      migration: createMigration({
        id: crypto.randomUUID(),
        source: profile.source,
        environment: profile.environment,
        safeConfig: profile.original,
        verifiedOwners: ownerProofs.map((p) => p.owner),
        ownerProofs,
        plans: [plan],
        profileId: profile.id,
        deploymentCommitment: profile.commitment,
        purpose: "extension",
      }),
    });
    setStep("progress");
    void runner.start();
  };

  const chain = chainId ? getChain(chainId) : null;
  return (
    <div className="space-y-3 rounded-xl bg-muted p-3">
      <p className="flex items-center gap-2 font-medium">
        <Network className="size-4" /> Add network
      </p>
      <p className="text-xs text-muted-foreground">
        Deploys this exact Safe (same address, same pinned recipe) on another network, or records it if it already exists there. It always installs the original owners and
        threshold, so it is blocked when governance changed on any known network or cannot be read.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={chainId ?? ""}
          aria-label="Network to add"
          onChange={(e) => {
            setChainId(Number(e.target.value));
            setAssessment(null);
            setPlan(null);
          }}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" onClick={() => void check()} disabled={busy || !chainId}>
          {busy ? <Loader2 className="animate-spin" /> : <Search />} Check network
        </Button>
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
      {assessment && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Status on {chain?.name}:</span> <TargetStatus t={assessment.target} />
          </div>
          {assessment.blockers.map((b) => (
            <Alert key={b} variant="danger">
              {b}
            </Alert>
          ))}
          {assessment.warnings.map((w) => (
            <Alert key={w} variant="info">
              {w}
            </Alert>
          ))}
          {assessment.action === "reuse" && (
            <Button size="sm" onClick={() => onUpdate((cur) => applyAssessment(cur, assessment))}>
              <Plus /> Record the existing Safe
            </Button>
          )}
          {assessment.action === "deploy" && plan && chain && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                One wallet confirmation{plan.confirmations.chainSwitch ? " plus a network switch" : ""}. Gas reserved up to {formatFee(plan.costs.deployMax, chain.nativeDecimals)} {chain.nativeSymbol}; source
                balance {plan.nativeBalance !== null ? `${formatAmount(plan.nativeBalance, chain.nativeDecimals)} ${chain.nativeSymbol}` : "unknown"}. No assets move. The Safe is verified
                onchain before it is marked ready.
              </p>
              {plan.blockers.map((b) => (
                <Alert key={b} variant="danger">
                  {b}
                </Alert>
              ))}
              {!isSource && <Alert variant="warning">Connect the source wallet {profile.source} to pay for the deployment.</Alert>}
              <Button size="sm" disabled={!plan.executable || !isSource || runner.running} onClick={deploy}>
                <Plus /> Deploy Safe on {chain.name}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
