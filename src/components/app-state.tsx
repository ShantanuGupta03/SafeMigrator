"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import type { Environment, Migration, NetworkDiscovery, SignerSlot } from "@/lib/domain/types";
import { discoverNetwork, fetchIndexerViaApi, type ManualImport } from "@/lib/services/discovery/asset-discovery";
import { DEFAULT_THRESHOLD } from "@/lib/services/signer-configuration";
import { chainOutcome, hasInFlightActions, migrationReducer, type MigrationEvent } from "@/lib/state/machine";
import { archiveMigration, draftKey, loadMigration, loadTestnetImports, saveMigration, clearMigration } from "@/lib/state/persistence";

const importKey = (m: ManualImport) => `${m.chainId}:${m.standard}:${m.contract.toLowerCase()}:${m.tokenId}`;

export type Step = "connect" | "discover" | "signers" | "preview" | "progress" | "complete";

export interface Draft {
  environment: Environment;
  selectedChains: number[];
  selectedAssetIds: string[];
  acknowledgedSuspicious: string[];
  manualImports: ManualImport[];
  signers: SignerSlot[];
  /** Signatures required per Safe transaction. */
  threshold: number;
  saltVariant: number;
  usedNonces: string[];
}

export function defaultSigners(): SignerSlot[] {
  return [
    { slot: 0, input: "", address: null, ensName: null, kind: "connected_eoa", label: "Current wallet", verification: null },
    { slot: 1, input: "", address: null, ensName: null, kind: "hardware", label: "Hardware wallet", verification: null },
    { slot: 2, input: "", address: null, ensName: null, kind: "independent_wallet", label: "Backup wallet", verification: null },
  ];
}

export function emptySigner(slot: number): SignerSlot {
  return { slot, input: "", address: null, ensName: null, kind: "independent_wallet", label: `Signer ${slot + 1}`, verification: null };
}

export function defaultDraft(environment: Environment = "testnet"): Draft {
  return {
    environment,
    selectedChains: chainsForEnvironment(environment).map((c) => c.id),
    selectedAssetIds: [],
    acknowledgedSuspicious: [],
    manualImports: [],
    signers: defaultSigners(),
    threshold: DEFAULT_THRESHOLD,
    saltVariant: 0,
    usedNonces: [],
  };
}

/** Owners, threshold and imports carry over (same Safe); the asset selection belongs to one run. */
function forNewRun(d: Draft): Draft {
  return { ...d, selectedAssetIds: [], acknowledgedSuspicious: [] };
}

export function isFullyCompleted(m: Migration): boolean {
  return m.runState === "finished" && m.chains.every((c) => chainOutcome(c) === "completed");
}

interface AppStateValue {
  source: Address | null;
  pinSource(a: Address | null): void;
  step: Step;
  setStep(s: Step): void;
  draft: Draft;
  setDraft(fn: (d: Draft) => Draft): void;
  discovery: Record<number, NetworkDiscovery>;
  scanning: Record<number, boolean>;
  scan(chainIds?: number[], manualImports?: ManualImport[]): Promise<void>;
  migration: Migration | null;
  dispatch(e: MigrationEvent): void;
  getMigration(): Migration | null;
  discardMigration(): void;
  /** Rescans the source for a follow-up run. Refused while a transaction is in flight. */
  startNewMigration(): boolean;
}

const Ctx = createContext<AppStateValue | null>(null);

function readDraft(source: Address): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(source));
    return raw ? ({ ...defaultDraft(), ...JSON.parse(raw) } as Draft) : null;
  } catch {
    return null;
  }
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [source, setSource] = useState<Address | null>(null);
  const [step, setStep] = useState<Step>("connect");
  const [draft, setDraftState] = useState<Draft>(() => defaultDraft());
  const [discovery, setDiscovery] = useState<Record<number, NetworkDiscovery>>({});
  const [scanning, setScanning] = useState<Record<number, boolean>>({});

  // The executor needs synchronous reads, so the ref is the source of truth; state mirrors it for rendering.
  const migrationRef = useRef<Migration | null>(null);
  const [migration, setMigration] = useState<Migration | null>(null);

  const dispatch = useCallback((e: MigrationEvent) => {
    const previous = migrationRef.current;
    if (e.type === "CREATE" && previous && previous.id !== e.migration.id) archiveMigration(localStorage, previous);
    migrationRef.current = migrationReducer(migrationRef.current, e);
    // Persist synchronously after every event: tx hashes must survive a tab close.
    if (migrationRef.current) saveMigration(localStorage, migrationRef.current);
    setMigration(migrationRef.current);
  }, []);

  const getMigration = useCallback(() => migrationRef.current, []);

  const pinSource = useCallback(
    (a: Address | null) => {
      setSource(a);
      setDiscovery({});
      if (!a) {
        migrationRef.current = null;
        setMigration(null);
        setStep("connect");
        return;
      }
      const storedDraft = readDraft(a);
      const testnetImports = loadTestnetImports(localStorage, a);
      const stored = loadMigration(localStorage, a);
      // A fully completed run is history: reconnecting starts from a fresh scan of the wallet.
      const completed = !!stored && isFullyCompleted(stored);
      setDraftState((current) => {
        const saved = storedDraft ?? current;
        const base = completed ? forNewRun(saved) : saved;
        const known = new Set(base.manualImports.map(importKey));
        const extra = testnetImports.filter((m) => !known.has(importKey(m)));
        return extra.length ? { ...base, manualImports: [...base.manualImports, ...extra] } : base;
      });
      dispatch({ type: "HYDRATE", migration: stored });
      if (!stored || completed) setStep("discover");
      else setStep(stored.runState === "finished" ? "complete" : "progress");
    },
    [dispatch],
  );

  const setDraft = useCallback(
    (fn: (d: Draft) => Draft) => {
      setDraftState((d) => {
        const next = fn(d);
        if (source) localStorage.setItem(draftKey(source), JSON.stringify(next));
        return next;
      });
    },
    [source],
  );

  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const scan = useCallback(
    async (chainIds?: number[], manualImports?: ManualImport[]) => {
      if (!source) return;
      const ids = chainIds ?? draftRef.current.selectedChains;
      const imports = manualImports ?? draftRef.current.manualImports;
      setScanning((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, true])) }));
      await Promise.all(
        ids.map(async (chainId) => {
          try {
            const result = await discoverNetwork({
              chainId,
              owner: source,
              client: getPublicClient(chainId),
              manualImports: imports,
              fetchIndexer: fetchIndexerViaApi,
            });
            setDiscovery((d) => ({ ...d, [chainId]: result }));
          } finally {
            setScanning((s) => ({ ...s, [chainId]: false }));
          }
        }),
      );
    },
    [source],
  );

  const discardMigration = useCallback(() => {
    if (source) clearMigration(localStorage, source);
    dispatch({ type: "RESET" });
  }, [dispatch, source]);

  const startNewMigration = useCallback(() => {
    const current = migrationRef.current;
    if (current && (current.runState === "running" || hasInFlightActions(current))) return false;
    setDraft(forNewRun);
    setDiscovery({});
    setStep("discover");
    return true;
  }, [setDraft]);

  const value = useMemo<AppStateValue>(
    () => ({
      source,
      pinSource,
      step,
      setStep,
      draft,
      setDraft,
      discovery,
      scanning,
      scan,
      migration,
      dispatch,
      getMigration,
      discardMigration,
      startNewMigration,
    }),
    [source, pinSource, step, draft, setDraft, discovery, scanning, scan, migration, dispatch, getMigration, discardMigration, startNewMigration],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState outside provider");
  return v;
}
