"use client";

import { ArrowRight, KeyRound, Loader2, ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import { appConfig } from "@/lib/config";
import type { Environment } from "@/lib/domain/types";
import { classifyAccountCode, describeAccountType, errorMessage, type AccountType } from "@/lib/services/wallet-connection";
import { cn } from "@/lib/utils";
import { defaultDraft, useAppState } from "../app-state";
import { useIsClient } from "../hooks/use-is-client";
import { AddressChip } from "../shared";

export function ConnectScreen() {
  const { pinSource, draft, setDraft } = useAppState();
  const { address, connector, isConnected } = useConnection();
  const isClient = useIsClient();
  const discovered = useConnectors();
  // Browser wallets announce themselves (EIP-6963) only on the client, so the server renders none.
  const connectors = isClient ? discovered : [];
  const { mutate: connect, isPending, error, variables } = useConnect();
  const [accountType, setAccountType] = useState<{ type: AccountType; delegate: string | null; chains: string[] } | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const chains = chainsForEnvironment(draft.environment);
      const results = await Promise.all(
        chains.map(async (c) => {
          try {
            return { chain: c.name, ...classifyAccountCode((await getPublicClient(c.id).getCode({ address })) ?? "0x") };
          } catch {
            return { chain: c.name, ...classifyAccountCode(undefined) };
          }
        }),
      );
      if (cancelled) return;
      const strongest =
        results.find((r) => r.accountType === "contract") ?? results.find((r) => r.accountType === "eip7702_delegated") ?? results.find((r) => r.accountType === "eoa") ?? results[0]!;
      setAccountType({
        type: strongest.accountType,
        delegate: strongest.delegate,
        chains: results.filter((r) => r.accountType === strongest.accountType).map((r) => r.chain),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [address, draft.environment]);

  const setEnvironment = (env: Environment) =>
    setDraft((d) => ({ ...defaultDraft(env), signers: d.signers, manualImports: d.manualImports, usedNonces: d.usedNonces }));

  return (
    <div className="flex flex-col items-center gap-block pt-4 md:pt-12">
      <div className="max-w-4xl space-y-6 text-center">
        <p className="tagline flex items-center justify-center gap-2 text-muted-foreground">
          <ShieldCheck className="size-4 text-safe-black" /> Noncustodial · Official Safe contracts
        </p>
        <h1 className="text-special font-medium md:text-hero">Your assets deserve more than one key.</h1>
        <p className="mx-auto max-w-2xl text-hero-body text-muted-foreground">Move assets from your existing wallet into a multisignature Safe.</p>
        <p className="text-sm">
          <Link href="/assess" className="font-medium underline underline-offset-2">
            Check a wallet without connecting
          </Link>
        </p>
      </div>

      <Card className="w-full max-w-[440px]">
        <CardContent className="space-y-6 p-8">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Networks</p>
            <div className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1" role="radiogroup" aria-label="Network environment">
              {(["testnet", "mainnet"] as const).map((env) => (
                <button
                  key={env}
                  role="radio"
                  aria-checked={draft.environment === env}
                  onClick={() => setEnvironment(env)}
                  className={cn(
                    "cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm transition",
                    draft.environment === env ? "bg-card shadow-card" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="block font-medium">{env === "testnet" ? "Testnets" : "Production"}</span>
                  <span className="text-xs text-muted-foreground">
                    {env === "testnet" ? "Sepolia · Gnosis Chiado · Base Sepolia" : appConfig.enableMainnetExecution ? "Execution gated per network" : "Discovery only in this build"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {!isConnected ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connect Wallet</p>
              {!isClient && (
                <Button size="lg" className="w-full justify-between" disabled>
                  <span className="flex items-center gap-3">
                    <Wallet className="size-5" /> Connect Wallet
                  </span>
                  <Loader2 className="animate-spin" />
                </Button>
              )}
              {isClient && connectors.length === 0 && <Alert variant="warning" title="No wallet detected">Install a browser wallet such as MetaMask or Rabby, or configure WalletConnect.</Alert>}
              {connectors.map((c, i) => (
                <Button
                  key={c.uid}
                  variant={i === 0 ? "default" : "outline"}
                  size="lg"
                  className="w-full justify-between"
                  disabled={isPending}
                  onClick={() => connect({ connector: c })}
                >
                  <span className="flex items-center gap-3">
                    {c.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.icon} alt="" className="size-6 rounded" />
                    ) : (
                      <Wallet className="size-5" />
                    )}
                    {c.name === "Injected" ? "Connect Wallet" : c.name}
                  </span>
                  {isPending && variables?.connector === c ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                </Button>
              ))}
              {error && <Alert variant="danger" title="Connection failed">{errorMessage(error)}</Alert>}
              <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                <KeyRound className="size-3.5" /> Safe Migrator never asks for a seed phrase or private key.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2 rounded-xl bg-muted p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connected</span>
                  <Badge variant="outline">{connector?.name ?? "Wallet"}</Badge>
                </div>
                {address && <AddressChip address={address} full className="bg-card" />}
                <p className="text-sm">
                  {accountType ? (
                    <>
                      <span className="font-medium">{describeAccountType(accountType.type)}</span>
                      {accountType.type !== "eoa" && <span className="text-muted-foreground"> on {accountType.chains.join(", ")}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Detecting account type…</span>
                  )}
                </p>
              </div>
              {accountType?.type === "eip7702_delegated" && (
                <Alert variant="warning" title="EIP-7702 delegation is not a multisig">
                  Your EOA delegates to {accountType.delegate}. It is still controlled by a single key; migrating into a Safe changes that.
                </Alert>
              )}
              {accountType?.type === "contract" && (
                <Alert variant="warning" title="Smart contract wallet detected">
                  This address is already a smart account. Transfers work, but check whether its own recovery setup already meets your needs.
                </Alert>
              )}
              <Button size="lg" className="w-full" onClick={() => address && pinSource(address)}>
                Continue <ArrowRight />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid w-full gap-4 md:grid-cols-3" aria-label="How it works">
        {[
          { title: "Discover", body: "Balances across networks, each one verified onchain before it is shown." },
          { title: "Deploy", body: "A multi-signature Safe (2-of-3 by default, or your own setup) at the same address wherever the official contracts allow." },
          { title: "Verify", body: "Only what you select moves, and the result is proven by reading the chain." },
        ].map((b, i) => (
          <Card key={b.title} className="p-8">
            <p className="mb-6 flex size-8 items-center justify-center rounded-full bg-labs-green text-sm font-medium">{i + 1}</p>
            <h3 className="text-h3 font-medium">{b.title}</h3>
            <p className="mt-3 text-muted-foreground">{b.body}</p>
          </Card>
        ))}
      </section>
    </div>
  );
}
