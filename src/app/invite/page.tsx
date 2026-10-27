"use client";

import Link from "next/link";
import { InviteScreen } from "@/components/screens/invite-screen";
import { AppWordmark } from "@/components/shared";

export default function InvitePage() {
  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/">
          <AppWordmark />
        </Link>
        <span className="text-xs text-muted-foreground">Owner verification</span>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-8 pb-section sm:px-6">
        <InviteScreen />
      </main>
    </>
  );
}
