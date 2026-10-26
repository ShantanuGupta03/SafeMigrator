"use client";

import { ArrowLeft, ArrowRight, Loader2, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { chainsForEnvironment, executionGate, getChain } from "@/lib/chains/registry";
import { formatAmount, formatUsd } from "@/lib/domain/amounts";
import type { AssetClassification, CoverageLevel, DiscoveredAsset, Migration, NetworkDiscovery } from "@/lib/domain/types";
import { coverageStatement } from "@/lib/services/discovery/asset-discovery";
import { isAutoSelectable, isManuallySelectable, isPreselectable } from "@/lib/services/discovery/classification";
import { parseAddressInput } from "@/lib/services/signer-configuration";
import { cn } from "@/lib/utils";
import { isFullyCompleted, useAppState } from "../app-state";
import { AddressChip, ChainIcon, ScreenHeading } from "../shared";

const CLASS_BADGE: Record<AssetClassification, { label: string; variant: "success" | "warning" | "danger" | "info" | "outline" }> = {
  transferable: { label: "Transferable", variant: "success" },
  specialized: { label: "Needs specialized migration", variant: "info" },
  non_transferable: { label: "Non-transferable", variant: "outline" },
  unsupported: { label: "Unsupported", variant: "outline" },
  suspicious: { label: "Suspicious", variant: "danger" },
};

function LastMigrationNotice({ migration, onView }: { migration: Migration; onView(): void }) {
  const safes = [...new Set(migration.chains.map((c) => c.safeAddress))];
  const completed = isFullyCompleted(migration);
  const when = new Date(migration.updatedAt).toLocaleString();
  return (
    <Alert variant={completed ? "info" : "warning"} title={completed ? `Your last migration finished on ${when}` : `Your last migration (${when}) has unfinished steps`}>
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Assets went to {safes.length === 1 ? "Safe" : "Safes"}{" "}
          {safes.map((s) => (
            <AddressChip key={s} address={s} className="mx-0.5 bg-card" />
          ))}
          . Keep the same owners and threshold to send new assets to the same Safe.
        </span>
        <Button size="sm" variant="outline" onClick={onView}>
          View last summary
        </Button>
      </div>
    </Alert>
  );
}

const COVERAGE_LABEL: Record<CoverageLevel, string> = {
  indexed: "indexed",
  known_list_only: "known tokens only",
  manual_only: "manual import only",
  unavailable: "unavailable",
};

export function DiscoverScreen() {
  const { draft, setDraft, discovery, scanning, scan, setStep, source, migration } = useAppState();
  const chains = chainsForEnvironment(draft.environment);
  const autoSelected = useRef(new Set<number>());

  useEffect(() => {
    const missing = draft.selectedChains.filter((id) => !discovery[id] && !scanning[id]);
    if (missing.length) void scan(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.selectedChains, source]);

  // First result per chain: pre-select only transferable assets with a trust signal.
  useEffect(() => {
    for (const [id, d] of Object.entries(discovery)) {
      const chainId = Number(id);
      if (autoSelected.current.has(chainId)) continue;
      autoSelected.current.add(chainId);
      const ids = d.assets.filter(isPreselectable).map((a) => a.id);
      if (ids.length && !draft.selectedAssetIds.some((x) => x.startsWith(`${chainId}:`))) {
        setDraft((dr) => ({ ...dr, selectedAssetIds: [...new Set([...dr.selectedAssetIds, ...ids])] }));
      }
    }
  }, [discovery, draft.selectedAssetIds, setDraft]);

  const networks = draft.selectedChains.map((id) => discovery[id]).filter(Boolean) as NetworkDiscovery[];
  const allAssets = networks.flatMap((n) => n.assets);
  const selected = new Set(draft.selectedAssetIds);
  const selectedAssets = allAssets.filter((a) => selected.has(a.id));
  const anyScanning = draft.selectedChains.some((id) => scanning[id]);
  const totalUsd = selectedAssets.reduce((s, a) => s + (a.usdValue ?? 0), 0);

  const toggleChain = (id: number) =>
    setDraft((d) => ({
      ...d,
      selectedChains: d.selectedChains.includes(id) ? d.selectedChains.filter((x) => x !== id) : [...d.selectedChains, id],
    }));

  const toggleAsset = (a: DiscoveredAsset) =>
    setDraft((d) => ({
      ...d,
      selectedAssetIds: d.selectedAssetIds.includes(a.id) ? d.selectedAssetIds.filter((x) => x !== a.id) : [...d.selectedAssetIds, a.id],
    }));

  const selectAll = () =>
    setDraft((d) => ({
      ...d,
      selectedAssetIds: [...new Set([...d.selectedAssetIds, ...allAssets.filter((a) => isAutoSelectable(a.classification)).map((a) => a.id)])],
    }));

  const clearAll = () => setDraft((d) => ({ ...d, selectedAssetIds: [] }));

  return (
    <div className="space-y-8">
      <ScreenHeading
        title="Here's what your wallet holds."
        subtitle="Balances below are read directly from each network. Select what should move into your Safe."
      />

      {migration?.runState === "finished" && <LastMigrationNotice migration={migration} onView={() => setStep("complete")} />}

      <div className="flex flex-wrap items-center gap-2">
        {chains.map((c) => {
          const on = draft.selectedChains.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggleChain(c.id)}
              aria-pressed={on}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition",
                on ? "border-primary bg-card" : "border-border text-muted-foreground opacity-70",
              )}
            >
              <ChainIcon chainId={c.id} size={18} />
              {c.name}
              {!executionGate(c.id).enabled && <span className="text-[10px] font-medium text-muted-foreground">(view only)</span>}
            </button>
          );
        })}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void scan()} disabled={anyScanning}>
            {anyScanning ? <Loader2 className="animate-spin" /> : <RefreshCw />} Rescan
          </Button>
          <Button variant="outline" size="sm" onClick={selectAll}>
            Select all transferable
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear
          </Button>
        </div>
      </div>

      {networks.length > 0 && (
        <p className="rounded-xl bg-muted px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Coverage: </span>
          {coverageStatement(networks)}
        </p>
      )}

      <div className="grid gap-4">
        {draft.selectedChains.map((id) => (
          <NetworkCard key={id} chainId={id} discovery={discovery[id]} scanning={!!scanning[id]} selected={selected} onToggle={toggleAsset} />
        ))}
      </div>

      <ManualImportCard />

      <div className="sticky bottom-4 z-10 rounded-2xl bg-card/95 px-4 py-3 shadow-card backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep("connect")}>
            <ArrowLeft /> Back
          </Button>
          <p className="text-sm">
            <span className="font-medium">{selectedAssets.length}</span> asset{selectedAssets.length === 1 ? "" : "s"} selected on{" "}
            <span className="font-medium">{new Set(selectedAssets.map((a) => a.chainId)).size}</span> network(s)
            {totalUsd > 0 && <span className="text-muted-foreground"> · ≈ {formatUsd(totalUsd)}</span>}
          </p>
          <Button disabled={selectedAssets.length === 0 || anyScanning} onClick={() => setStep("signers")}>
            Choose signers <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function NetworkCard({
  chainId,
  discovery,
  scanning,
  selected,
  onToggle,
}: {
  chainId: number;
  discovery: NetworkDiscovery | undefined;
  scanning: boolean;
  selected: Set<string>;
  onToggle: (a: DiscoveredAsset) => void;
}) {
  const { draft } = useAppState();
  const chain = getChain(chainId);
  const gate = executionGate(chainId);
  const assets = useMemo(() => discovery?.assets ?? [], [discovery]);
  const counts = useMemo(() => {
    const c: Record<AssetClassification, number> = { transferable: 0, specialized: 0, non_transferable: 0, unsupported: 0, suspicious: 0 };
    for (const a of assets) c[a.classification]++;
    return c;
  }, [assets]);
  const usd = assets.filter((a) => a.classification === "transferable").reduce((s, a) => s + (a.usdValue ?? 0), 0);
  const native = discovery?.nativeBalance;
  const ack = new Set(draft.acknowledgedSuspicious);
  const [showAll, setShowAll] = useState(false);
  const [showSuspicious, setShowSuspicious] = useState(false);
  const [showAllSuspicious, setShowAllSuspicious] = useState(false);
  const { regular, suspicious } = useMemo(() => {
    const sorted = [...assets].sort(
      (a, b) => CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification] || STD_ORDER[a.standard] - STD_ORDER[b.standard] || (b.usdValue ?? 0) - (a.usdValue ?? 0),
    );
    // Keep acknowledged suspicious assets visible so a selection is never hidden.
    return {
      regular: sorted.filter((a) => a.classification !== "suspicious" || selected.has(a.id)),
      suspicious: sorted.filter((a) => a.classification === "suspicious" && !selected.has(a.id)),
    };
  }, [assets, selected]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div className="flex items-center gap-3">
          <ChainIcon chainId={chainId} size={36} />
          <div>
            <p className="font-medium">{chain.name}</p>
            <p className="text-sm text-muted-foreground">
              {native !== null && native !== undefined ? `${formatAmount(native, chain.nativeDecimals)} ${chain.nativeSymbol}` : scanning ? "Scanning…" : "Balance unknown"}
              {usd > 0 && ` · ≈ ${formatUsd(usd)}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {scanning && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Badge variant="success">{counts.transferable} transferable</Badge>
          {counts.specialized + counts.non_transferable + counts.unsupported > 0 && (
            <Badge variant="outline">{counts.specialized + counts.non_transferable + counts.unsupported} unsupported positions</Badge>
          )}
          {counts.suspicious > 0 && <Badge variant="danger">{counts.suspicious} suspicious</Badge>}
          {!gate.enabled && <Badge variant="warning">Discovery only</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {discovery && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Badge variant="outline">Native: {discovery.coverage.native ? "verified" : "unavailable"}</Badge>
            <Badge variant="outline">ERC-20: {COVERAGE_LABEL[discovery.coverage.erc20]}</Badge>
            <Badge variant="outline">ERC-721: {COVERAGE_LABEL[discovery.coverage.erc721]}</Badge>
            <Badge variant="outline">ERC-1155: {COVERAGE_LABEL[discovery.coverage.erc1155]}</Badge>
            {discovery.indexer && <Badge variant="outline">via {discovery.indexer}</Badge>}
            {discovery.droppedZeroBalance > 0 && <Badge variant="outline">{discovery.droppedZeroBalance} stale/zero entries hidden</Badge>}
          </div>
        )}
        {!gate.enabled && <Alert variant="warning">{gate.reason}</Alert>}
        {discovery?.status === "error" && (
          <Alert variant="danger" title="Network scan failed">
            {discovery.errors.join(" ")}
          </Alert>
        )}
        {discovery?.status === "partial" && (
          <Alert variant="warning" title="Partial results">
            <ul className="list-disc pl-4">
              {discovery.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        )}
        {discovery && discovery.status !== "error" && assets.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No assets with a non-zero balance were found on {chain.name}.</p>
        )}
        {regular.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {(showAll ? regular : regular.slice(0, LIST_LIMIT)).map((a) => (
              <AssetRow key={a.id} asset={a} gateEnabled={gate.enabled} acknowledged={ack.has(a.id)} selected={selected.has(a.id)} onToggle={onToggle} />
            ))}
            {regular.length > LIST_LIMIT && (
              <button className="w-full p-2 text-center text-xs font-medium hover:bg-muted" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show ${regular.length - LIST_LIMIT} more`}
              </button>
            )}
          </div>
        )}
        {suspicious.length > 0 && (
          <div className="rounded-xl border border-destructive/30">
            <button
              className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm"
              onClick={() => setShowSuspicious((v) => !v)}
              aria-expanded={showSuspicious}
            >
              <span className="flex items-center gap-2 font-medium text-destructive">
                <ShieldAlert className="size-4" /> {suspicious.length} suspicious asset{suspicious.length > 1 ? "s" : ""} hidden
              </span>
              <span className="text-xs text-muted-foreground">
                Likely spam or impersonation. Never selected automatically and never interacted with unless you opt in. {showSuspicious ? "Hide" : "Review"}
              </span>
            </button>
            {showSuspicious && (
              <div className="divide-y divide-border border-t border-destructive/30">
                {suspicious.slice(0, showAllSuspicious ? undefined : LIST_LIMIT).map((a) => (
                  <AssetRow key={a.id} asset={a} gateEnabled={gate.enabled} acknowledged={ack.has(a.id)} selected={selected.has(a.id)} onToggle={onToggle} />
                ))}
                {suspicious.length > LIST_LIMIT && !showAllSuspicious && (
                  <button className="w-full p-2 text-center text-xs font-medium hover:bg-muted" onClick={() => setShowAllSuspicious(true)}>
                    Show {suspicious.length - LIST_LIMIT} more
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const LIST_LIMIT = 20;
const CLASS_ORDER: Record<AssetClassification, number> = { transferable: 0, specialized: 1, non_transferable: 2, unsupported: 3, suspicious: 4 };
const STD_ORDER: Record<DiscoveredAsset["standard"], number> = { native: 0, erc20: 1, erc721: 2, erc1155: 3 };

function AssetRow({
  asset: a,
  gateEnabled,
  acknowledged,
  selected,
  onToggle,
}: {
  asset: DiscoveredAsset;
  gateEnabled: boolean;
  acknowledged: boolean;
  selected: boolean;
  onToggle: (a: DiscoveredAsset) => void;
}) {
  const { setDraft } = useAppState();
  const selectable = gateEnabled && isManuallySelectable(a.classification) && (a.classification !== "suspicious" || acknowledged);
  return (
    <div className={cn("flex flex-wrap items-start gap-3 p-3 text-sm sm:flex-nowrap", !selectable && "bg-muted/40")}>
      <Checkbox aria-label={`Select ${a.symbol}`} checked={selected} disabled={!selectable} onChange={() => onToggle(a)} className="mt-1" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-medium">{a.standard === "native" ? a.symbol : a.name}</span>
          {a.standard !== "native" && <span className="break-all text-muted-foreground">{a.symbol}</span>}
          <Badge variant="outline">{a.standard === "native" ? "Native" : a.standard.toUpperCase().replace("ERC", "ERC-")}</Badge>
          <Badge variant={CLASS_BADGE[a.classification].variant}>{CLASS_BADGE[a.classification].label}</Badge>
          {a.flags.includes("rebasing") && <Badge variant="info">Rebasing</Badge>}
        </div>
        {a.contract && <AddressChip address={a.contract} chainId={a.chainId} />}
        {a.reasons.length > 0 && <p className="text-xs text-muted-foreground">{a.reasons.join(" ")}</p>}
        {a.classification === "suspicious" && !acknowledged && gateEnabled && (
          <button
            className="inline-flex items-center gap-1 text-xs font-medium text-destructive underline"
            onClick={() => setDraft((d) => ({ ...d, acknowledgedSuspicious: [...d.acknowledgedSuspicious, a.id] }))}
          >
            <ShieldAlert className="size-3.5" /> I understand the risk — allow selecting this asset
          </button>
        )}
      </div>
      <div className="text-right">
        <p className="font-mono font-medium">{a.standard === "erc721" ? `#${a.tokenId}` : formatAmount(a.balance, a.decimals)}</p>
        {a.standard === "erc1155" && <p className="text-xs text-muted-foreground">id #{a.tokenId}</p>}
        <p className="text-xs text-muted-foreground">{formatUsd(a.usdValue)}</p>
      </div>
    </div>
  );
}

function ManualImportCard() {
  const { draft, setDraft, scan } = useAppState();
  const chains = chainsForEnvironment(draft.environment);
  const [chainId, setChainId] = useState<number>(chains[0]!.id);
  const [standard, setStandard] = useState<"erc20" | "erc721" | "erc1155">("erc20");
  const [contract, setContract] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const address = parseAddressInput(contract);
    if (!address) return setError("Enter a valid contract address.");
    if (standard !== "erc20" && !/^\d+$/.test(tokenId.trim())) return setError("Token ID must be a non-negative integer.");
    setError(null);
    const entry = { chainId, standard, contract: address, tokenId: standard === "erc20" ? null : BigInt(tokenId.trim()).toString() };
    const imports = [
      ...draft.manualImports.filter(
        (m) => !(m.chainId === entry.chainId && m.contract.toLowerCase() === address.toLowerCase() && m.tokenId === entry.tokenId),
      ),
      entry,
    ];
    setDraft((d) => ({
      ...d,
      selectedChains: d.selectedChains.includes(chainId) ? d.selectedChains : [...d.selectedChains, chainId],
      manualImports: imports,
    }));
    setContract("");
    setTokenId("");
    void scan([chainId], imports);
  };

  return (
    <Card>
      <CardHeader>
        <p className="font-medium">Missing something? Import a token or NFT</p>
        <p className="text-sm text-muted-foreground">Indexers cannot see every asset. Imports are verified onchain before they appear above.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto_auto]">
          <Select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} aria-label="Network">
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select value={standard} onChange={(e) => setStandard(e.target.value as typeof standard)} aria-label="Token standard">
            <option value="erc20">ERC-20</option>
            <option value="erc721">ERC-721</option>
            <option value="erc1155">ERC-1155</option>
          </Select>
          <Input placeholder="Contract address 0x…" value={contract} onChange={(e) => setContract(e.target.value)} aria-label="Contract address" />
          {standard !== "erc20" && <Input placeholder="Token ID" value={tokenId} onChange={(e) => setTokenId(e.target.value)} className="sm:w-32" aria-label="Token ID" />}
          <Button variant="outline" onClick={submit}>
            <Plus /> Import
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {draft.manualImports.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {draft.manualImports.map((m) => (
              <Badge key={`${m.chainId}:${m.contract}:${m.tokenId}`} variant="outline" className="gap-2">
                {getChain(m.chainId).name} · {m.standard.toUpperCase()} · {m.contract.slice(0, 8)}…{m.tokenId !== null && ` #${m.tokenId}`}
                <button
                  aria-label="Remove import"
                  onClick={() => setDraft((d) => ({ ...d, manualImports: d.manualImports.filter((x) => x !== m) }))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
