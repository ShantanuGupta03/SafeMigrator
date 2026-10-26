"use client";

import { AppHeader } from "@/components/app-header";
import { useAppState } from "@/components/app-state";
import { CompleteScreen } from "@/components/screens/complete-screen";
import { ConnectScreen } from "@/components/screens/connect-screen";
import { DiscoverScreen } from "@/components/screens/discover-screen";
import { PreviewScreen } from "@/components/screens/preview-screen";
import { ProgressScreen } from "@/components/screens/progress-screen";
import { SignersScreen } from "@/components/screens/signers-screen";

export default function Home() {
  const { step, source } = useAppState();
  const effective = source ? step : "connect";
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 pt-12 pb-section sm:px-6 md:pt-16">
        {effective === "connect" && <ConnectScreen />}
        {effective === "discover" && <DiscoverScreen />}
        {effective === "signers" && <SignersScreen />}
        {effective === "preview" && <PreviewScreen />}
        {effective === "progress" && <ProgressScreen />}
        {effective === "complete" && <CompleteScreen />}
      </main>
      <footer className="bg-safe-black text-sm text-white/60">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <p className="mb-2 font-medium text-safe-white">Safe Migrator</p>
          <p className="max-w-3xl">
            A noncustodial transaction orchestration interface. It never asks for seed phrases or private keys, and never becomes an owner of your Safe. Proof of concept — not
            audited.
          </p>
        </div>
      </footer>
    </>
  );
}
