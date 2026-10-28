"use client";

import { ArrowRight, Loader2, Search, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { AssetAmountControl, intentForDraft, setIntent } from "@/components/asset-amount-control";
import { GasRetentionPanel } from "@/components/gas-retention-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import { defaultNewDestination } from "@/lib/domain/destination";
import { defaultGasRetention } from "@/lib/domain/gas-retention";
import { assessPublicWallet } from "@/lib/services/assessment";
import { isManuallySelectable } from "@/lib/services/discovery/classification";
import { parseAddressInput } from "@/lib/services/signer-configuration";
import { saveAssessmentDraft } from "@/lib/state/assessment-draft";
import { formatAmount, formatUsd } from "@/lib/domain/amounts";
import type { Environment } from "@/lib/domain/types";
import { useAppState } from "@/components/app-state";

export default function AssessPage() {
  const router = useRouter();
  const { draft: connectedDraft } = useAppState();
  const [environment, setEnvironment] = useState<Environment>("testnet");
  const [input, setInput] = useState("");
  const [selectedChains, setSelectedChains] = useState<number[]>(() => chainsForEnvironment("testnet").map((c) => c.id));
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [transferIntents, setTransferIntents] = useState(connectedDraft.transferIntents);
  const [gasRetention, setGasRetention] = useState(() => defaultGasRetention(chainsForEnvironment("testnet").map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<Awaited<ReturnType<typeof assessPublicWallet>> | null>(null);

  const chains = chainsForEnvironment(environment);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const parsed = parseAddressInput(input.trim());
      if (!parsed) throw new Error("Enter a valid address or ENS name.");
      const result = await assessPublicWallet({
        source: parsed,
        environment,
        selectedChains,
        selectedAssetIds,
        acknowledgedSuspicious: [],
        manualImports: [],
        clientFor: getPublicClient,
      });
      setAssessment(result);
      if (!selectedAssetIds.length) setSelectedAssetIds(result.selection.assetIds);
      saveAssessmentDraft(localStorage, {
        environment,
        source: parsed,
        selectedChains,
        selectedAssetIds: selectedAssetIds.length ? selectedAssetIds : result.selection.assetIds,
        transferIntents,
        gasRetention,
        destination: defaultNewDestination({ owners: [parsed], threshold: 1, saltNonce: "0" }),
        acknowledgedSuspicious: [],
        assessedAt: result.assessedAt,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const assets = useMemo(() => assessment?.selection.assets ?? [], [assessment]);

  const continueConnect = () => {
    if (!assessment) return;
    saveAssessmentDraft(localStorage, {
      environment,
      source: assessment.source,
      selectedChains,
      selectedAssetIds: assessment.selection.assetIds,
      transferIntents,
      gasRetention,
      destination: defaultNewDestination({ owners: [assessment.source], threshold: 1, saltNonce: "0" }),
      acknowledgedSuspicious: [],
      assessedAt: assessment.assessedAt,
    });
    router.push("/");
  };

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-medium">Check a wallet</h1>
          <p className="text-sm text-muted-foreground">Read-only assessment. No signing required. Connect the same address when you are ready to migrate.</p>
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Address or ENS</label>
                <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… or name.eth" className="mt-1 font-mono" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Environment</label>
                <select
                  className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
                  value={environment}
                  onChange={(e) => {
                    const env = e.target.value as Environment;
                    setEnvironment(env);
                    setSelectedChains(chainsForEnvironment(env).map((c) => c.id));
                    setGasRetention(defaultGasRetention(chainsForEnvironment(env).map((c) => c.id)));
                  }}
                >
                  <option value="testnet">Testnets</option>
                  <option value="mainnet">Production (discovery)</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {chains.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs ${selectedChains.includes(c.id) ? "border-primary bg-muted" : "opacity-60"}`}
                  onClick={() => setSelectedChains((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <Button onClick={() => void run()} disabled={busy || !input.trim()} className="w-full sm:w-auto">
              {busy ? <Loader2 className="animate-spin" /> : <Search />} Run assessment
            </Button>
            {error && (
              <Alert variant="danger" title="Could not assess">
                {error}
              </Alert>
            )}
          </CardContent>
        </Card>

        {assessment && (
          <>
            <Alert variant="info" title="Indicative only">
              {assessment.note} Last checked {new Date(assessment.assessedAt).toLocaleString()}.
            </Alert>
            <GasRetentionPanel prefs={gasRetention} chainIds={selectedChains} onChange={setGasRetention} />
            <div className="space-y-2">
              {assets.map((a) => {
                const on = assessment.selection.assetIds.includes(a.id);
                return (
                  <div key={a.id} className="rounded-xl border border-border p-3 text-sm">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setSelectedAssetIds((ids) => (ids.includes(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id]))
                        }
                        disabled={!isManuallySelectable(a.classification)}
                      />
                      <span className="font-medium">{a.symbol}</span>
                      <span className="text-muted-foreground">
                        {formatAmount(a.balance, a.decimals)} · {formatUsd(a.usdValue)}
                      </span>
                      <span className="ml-auto text-xs capitalize text-muted-foreground">{a.classification}</span>
                    </label>
                    <AssetAmountControl
                      asset={a}
                      selected={on}
                      intent={intentForDraft(transferIntents, a)}
                      onIntent={(i) => setTransferIntents((m) => setIntent(m, a.id, i))}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={continueConnect}>
                <Wallet /> Connect to continue <ArrowRight />
              </Button>
              <Link href="/" className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium">
                Back to app
              </Link>
            </div>
          </>
        )}
      </main>
    </>
  );
}
