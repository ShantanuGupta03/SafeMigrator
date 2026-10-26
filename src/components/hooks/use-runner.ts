"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useConfig } from "wagmi";
import { getPublicClient } from "@/lib/chains/clients";
import { runMigration } from "@/lib/services/migration-execution";
import { createWagmiWalletPort } from "@/lib/wallet/wagmi-port";
import { useAppState } from "../app-state";

/** Module-level guard: one execution loop per tab, no matter how many components mount. */
let active = false;
let stopRequested = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const snapshot = () => (active ? (stopRequested ? "stopping" : "running") : "idle");
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useRunner() {
  const wagmiConfig = useConfig();
  const { dispatch, getMigration } = useAppState();
  const status = useSyncExternalStore(subscribe, snapshot, () => "idle" as const);
  const running = status !== "idle";
  const port = useMemo(() => createWagmiWalletPort(wagmiConfig), [wagmiConfig]);

  const start = useCallback(async () => {
    if (active || !getMigration()) return;
    active = true;
    stopRequested = false;
    emit();
    try {
      await runMigration({
        wallet: port,
        clientFor: getPublicClient,
        dispatch,
        getMigration: () => getMigration()!,
        shouldStop: () => stopRequested,
      });
    } finally {
      active = false;
      emit();
    }
  }, [dispatch, getMigration, port]);

  const pause = useCallback(() => {
    stopRequested = true;
    emit();
  }, []);

  return { running, start, pause, stopping: status === "stopping" };
}
