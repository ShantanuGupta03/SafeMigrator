"use client";

import Link from "next/link";
import { LogOut, FlaskConical, Vault } from "lucide-react";
import { useConnection, useDisconnect } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, shortAddress } from "@/lib/utils";
import { useAppState } from "./app-state";
import { AppWordmark, Stepper } from "./shared";

export function AppHeader() {
  const { step, source, draft, pinSource, setStep, profiles, migration } = useAppState();
  const runActive = migration?.runState === "running";
  const { address } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const mismatch = source && address && source.toLowerCase() !== address.toLowerCase();
  const signerSlot = mismatch ? draft.signers.find((s) => s.address?.toLowerCase() === address.toLowerCase()) : undefined;
  return (
    <header className="sticky top-0 z-20 bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <AppWordmark />
          <Badge variant={draft.environment === "testnet" ? "default" : "warning"} className="bg-card shadow-card">
            {draft.environment === "testnet" ? "Testnet" : "Production networks"}
          </Badge>
        </div>
        <Stepper step={step} />
        <div className="flex items-center gap-1 rounded-2xl bg-card p-1 shadow-card">
          {source && (
            <button
              type="button"
              onClick={() => setStep("safe")}
              disabled={runActive}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40",
                step === "safe" && "bg-muted text-foreground",
              )}
            >
              <Vault className="size-4" /> <span className="hidden sm:inline">Saved Safes</span>
              {profiles.length > 0 && <span className="rounded-md bg-muted px-1.5 text-xs">{profiles.filter((p) => p.environment === draft.environment).length}</span>}
            </button>
          )}
          {draft.environment === "testnet" && (
            <Link
              href="/testnet"
              className="hidden h-8 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground md:inline-flex"
            >
              <FlaskConical className="size-4" /> Test assets
            </Link>
          )}
          {address ? (
            <span className="flex h-8 items-center gap-2 rounded-xl bg-muted pr-1 pl-3 font-mono text-xs">
              <span className="size-2 rounded-full bg-safe-green" />
              {shortAddress(address)}
              <Button
                variant="ghost"
                size="icon"
                className="size-6 hover:bg-card"
                aria-label="Disconnect"
                onClick={() => {
                  disconnect();
                  pinSource(null);
                }}
              >
                <LogOut className="size-3.5" />
              </Button>
            </span>
          ) : (
            <span className="flex h-8 items-center px-3 text-sm text-muted-foreground">Not connected</span>
          )}
        </div>
      </div>
      {mismatch && signerSlot && (
        <div className="bg-labs-accent px-4 py-2 text-center text-xs font-medium text-safe-black">
          Connected as Signer {signerSlot.slot + 1} ({signerSlot.label || shortAddress(address)}).{" "}
          {step === "signers" ? "Use “Verify control” on its card to sign the ownership message" : "Go to the Signers step to verify this owner"}, then switch your wallet back to the
          source {shortAddress(source)}. Migration transactions are only sent from the source.
        </div>
      )}
      {mismatch && !signerSlot && (
        <div className="bg-warning/20 px-4 py-1.5 text-center text-xs font-medium text-warning-foreground">
          Connected account {shortAddress(address)} is not the migration source {shortAddress(source)}. Transactions are blocked until you switch back.
        </div>
      )}
    </header>
  );
}
