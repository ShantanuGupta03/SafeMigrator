"use client";

import Link from "next/link";
import { ReceiptInspector } from "@/components/screens/receipt-inspector";
import { AppWordmark } from "@/components/shared";

export default function ReceiptPage() {
  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/">
          <AppWordmark />
        </Link>
        <span className="text-xs text-muted-foreground">Receipt inspector</span>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-8 pb-section sm:px-6">
        <ReceiptInspector />
      </main>
    </>
  );
}
