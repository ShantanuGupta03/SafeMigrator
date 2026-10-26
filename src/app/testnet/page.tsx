"use client";

import { ArrowLeft, ExternalLink, Loader2, Rocket } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getAddress, parseUnits, type Abi, type Address, type Hex } from "viem";
import { useConfig, useConnection } from "wagmi";
import { deployContract, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { useAppState } from "@/components/app-state";
import { AddressChip, AppWordmark, ChainLabel, TxLink } from "@/components/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { chainsForEnvironment, findChain } from "@/lib/chains/registry";
import type { ManualImport } from "@/lib/services/discovery/asset-discovery";
import { testnetAssetsKey, type TestnetDeployment } from "@/lib/state/persistence";
import { errorMessage, isUserRejection } from "@/lib/services/wallet-connection";
import artifactsFile from "@/lib/testnet/artifacts.json";

type ArtifactName = keyof typeof artifactsFile.artifacts;

interface Preset {
  key: string;
  artifact: ArtifactName;
  title: string;
  description: string;
  args: readonly unknown[];
  scenario: string;
  imports: (contract: Address, chainId: number) => ManualImport[];
}

const erc20 = (contract: Address, chainId: number): ManualImport[] => [{ chainId, standard: "erc20", contract, tokenId: null }];

const PRESETS: Preset[] = [
  {
    key: "musd",
    artifact: "SampleToken",
    title: "Demo USD (6 decimals)",
    description: "Mints 1,000,000 mUSD to you.",
    args: ["Migrator Demo USD", "mUSD", 6, parseUnits("1000000", 6)],
    scenario: "Standard ERC-20 transfer",
    imports: erc20,
  },
  {
    key: "mdt",
    artifact: "SampleToken",
    title: "Demo Token (18 decimals)",
    description: "Mints 5,000 MDT to you.",
    args: ["Migrator Demo Token", "MDT", 18, parseUnits("5000", 18)],
    scenario: "Standard ERC-20 transfer",
    imports: erc20,
  },
  {
    key: "feed",
    artifact: "FeeOnTransferToken",
    title: "Fee-on-transfer token",
    description: "Takes a 1% fee on every transfer.",
    args: [parseUnits("1000", 18)],
    scenario: "Shows “verified, amount differs” when the Safe receives less than was sent",
    imports: erc20,
  },
  {
    key: "rstd",
    artifact: "RestrictedToken",
    title: "Restricted token",
    description: "Every transfer reverts.",
    args: [parseUnits("1000", 18)],
    scenario: "Shows a non-transferable asset: the simulation fails and it is excluded",
    imports: erc20,
  },
  {
    key: "mnft",
    artifact: "SampleNFT",
    title: "Demo NFT collection (ERC-721)",
    description: "Mints token IDs 1–3 to you.",
    args: ["Migrator Demo NFT", "MNFT", false, 3n],
    scenario: "ERC-721 safeTransferFrom into the Safe",
    imports: (contract, chainId) => ["1", "2", "3"].map((tokenId) => ({ chainId, standard: "erc721" as const, contract, tokenId })),
  },
  {
    key: "sbt",
    artifact: "SampleNFT",
    title: "Soulbound badge (ERC-721)",
    description: "Mints token ID 1; transfers revert.",
    args: ["Migrator Soulbound Badge", "SBT", true, 1n],
    scenario: "Account-bound NFT that must stay behind",
    imports: (contract, chainId) => [{ chainId, standard: "erc721", contract, tokenId: "1" }],
  },
  {
    key: "m1155",
    artifact: "SampleMultiToken",
    title: "Demo multi-token (ERC-1155)",
    description: "Mints IDs 1, 2, 3 with amounts 500 / 50 / 5.",
    args: [],
    scenario: "ERC-1155 safeBatchTransferFrom",
    imports: (contract, chainId) => ["1", "2", "3"].map((tokenId) => ({ chainId, standard: "erc1155" as const, contract, tokenId })),
  },
];

interface Deployed extends TestnetDeployment {
  preset: string;
  address: Address;
}

// `version` only exists to invalidate memoization after a write.
function readDeployed(account: string | undefined, version: number): Deployed[] {
  void version;
  if (!account || typeof window === "undefined") return [];
  try {
    const list = JSON.parse(localStorage.getItem(testnetAssetsKey(account)) ?? "[]");
    return Array.isArray(list) ? (list as Deployed[]) : [];
  } catch {
    return [];
  }
}

export default function TestnetToolsPage() {
  const wagmiConfig = useConfig();
  const { address, chainId } = useConnection();
  const { setDraft, source } = useAppState();
  const [version, setVersion] = useState(0);
  const deployed = useMemo(() => readDeployed(address, version), [address, version]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const testnets = chainsForEnvironment("testnet");
  const chain = chainId ? findChain(chainId) : undefined;
  const onTestnet = chain?.environment === "testnet";

  const addImports = (imports: ManualImport[]) =>
    setDraft((d) => {
      const seen = new Set(d.manualImports.map((m) => `${m.chainId}:${m.standard}:${m.contract.toLowerCase()}:${m.tokenId}`));
      const fresh = imports.filter((m) => !seen.has(`${m.chainId}:${m.standard}:${m.contract.toLowerCase()}:${m.tokenId}`));
      return { ...d, manualImports: [...d.manualImports, ...fresh] };
    });

  const deploy = async (p: Preset) => {
    if (!address || !chainId || !onTestnet) return;
    setBusy(p.key);
    setError(null);
    try {
      const art = artifactsFile.artifacts[p.artifact];
      const hash = await deployContract(wagmiConfig, {
        abi: art.abi as Abi,
        bytecode: art.bytecode as Hex,
        args: p.args,
        chainId,
        account: address,
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment transaction reverted.");
      const contract = getAddress(receipt.contractAddress);
      const entry: Deployed = { preset: p.key, chainId, address: contract, txHash: hash, imports: p.imports(contract, chainId) };
      localStorage.setItem(testnetAssetsKey(address), JSON.stringify([...readDeployed(address, version), entry]));
      setVersion((v) => v + 1);
      addImports(entry.imports);
    } catch (e) {
      setError(isUserRejection(e) ? "You rejected the deployment in your wallet." : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <AppWordmark />
          <Link href="/" className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-card px-4 text-sm font-medium shadow-card hover:bg-muted">
            <ArrowLeft className="size-4" /> Back to migrator
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-8 px-4 pt-12 pb-section sm:px-6 md:pt-section">
        <div className="space-y-4 pb-4">
          <p className="tagline text-muted-foreground">Testnet tools</p>
          <h1 className="text-h2 leading-[44px] font-normal md:leading-[120%] md:font-medium">Testnet demo assets</h1>
          <p className="max-w-2xl text-lead text-muted-foreground">
            Deploy real sample tokens and NFTs from your wallet on Sepolia, Gnosis Chiado or Base Sepolia, then migrate them. Each deployment is one transaction; the contracts mint their supply to you.
            Deployed contracts are added to your manual import list so discovery checks them even before an indexer picks them up.
          </p>
        </div>

        <Card>
          <CardHeader>
            <p className="font-medium">1. Get testnet gas</p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {testnets.map((c) => (
              <div key={c.id} className="space-y-1 rounded-xl bg-muted p-3 text-sm">
                <ChainLabel chainId={c.id} />
                {c.faucets.map((f) => (
                  <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline">
                    {f.name} <ExternalLink className="size-3" />
                  </a>
                ))}
                {chainId !== c.id && address && (
                  <Button size="sm" variant="outline" className="mt-1" onClick={() => void switchChain(wagmiConfig, { chainId: c.id }).catch((e) => setError(errorMessage(e)))}>
                    Switch wallet to {c.name}
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {!address && <Alert variant="warning">Connect a wallet on the main page first.</Alert>}
        {address && !onTestnet && <Alert variant="warning">Switch your wallet to Sepolia, Gnosis Chiado or Base Sepolia to deploy demo assets.</Alert>}
        {address && source && address.toLowerCase() !== source.toLowerCase() && (
          <Alert variant="info">Assets will be minted to the connected account {address}, which is not the current migration source.</Alert>
        )}
        {error && <Alert variant="danger">{error}</Alert>}

        <Card>
          <CardHeader>
            <p className="font-medium">2. Deploy sample assets {chain && onTestnet ? `on ${chain.name}` : ""}</p>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {PRESETS.map((p) => {
              const mine = deployed.filter((d) => d.preset === p.key && d.chainId === chainId);
              return (
                <div key={p.key} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{p.title}</p>
                    <p className="text-muted-foreground">{p.description}</p>
                    <Badge variant="outline">{p.scenario}</Badge>
                    {mine.map((d) => (
                      <div key={d.address} className="flex flex-wrap items-center gap-2 pt-1">
                        <AddressChip address={d.address} chainId={d.chainId} />
                        <TxLink chainId={d.chainId} hash={d.txHash} label="deploy tx" />
                      </div>
                    ))}
                  </div>
                  <Button size="sm" onClick={() => void deploy(p)} disabled={!onTestnet || busy !== null}>
                    {busy === p.key ? <Loader2 className="animate-spin" /> : <Rocket />} Deploy
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Alert variant="info" title="3. Migrate">
          Return to the migrator and rescan your portfolio. The demo assets appear under their network; the restricted token and soulbound badge are flagged non-transferable after
          simulation.
        </Alert>
      </main>
    </>
  );
}
