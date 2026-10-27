"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import type { SafeProfile } from "@/lib/domain/profile";
import type { Environment, Migration, NetworkDiscovery, SignerSlot } from "@/lib/domain/types";
import { discoverNetwork, fetchIndexerViaApi, type ManualImport } from "@/lib/services/discovery/asset-discovery";
import { enrichWithAdapters } from "@/lib/services/protocols";
import { effectiveSelection, importsForChains, type EffectiveSelection } from "@/lib/services/selection";
import { syncProfileWithMigration } from "@/lib/services/safe-profile";
import { DEFAULT_THRESHOLD } from "@/lib/services/signer-configuration";
import { chainOutcome, hasInFlightActions, migrationReducer, type MigrationEvent } from "@/lib/state/machine";
import { archiveMigration, draftKey, loadMigration, loadMigrationHistory, loadTestnetImports, saveMigration, clearMigration } from "@/lib/state/persistence";
import type { OwnerInvite } from "@/lib/services/owner-invites";
import { loadInvites, loadProfiles, saveInvites, saveProfiles, upsertProfile, withLegacyProfiles, type LoadedProfiles } from "@/lib/state/profile-store";

const importKey = (m: ManualImport) => `${m.chainId}:${m.standard}:${m.contract.toLowerCase()}:${m.tokenId}`;

export type Step = "connect" | "discover" | "signers" | "preview" | "progress" | "complete" | "safe";

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
  /** Explicit salt from a saved profile; overrides `saltVariant` so the configuration reproduces that Safe. */
  saltNonce: string | null;
  usedNonces: string[];
  /** Saved Safe profile this draft works with (v1.5+). Null starts a new Safe. */
  profileId: string | null;
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
    saltNonce: null,
    usedNonces: [],
    profileId: null,
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
  /** The only assets and networks that may be planned or executed. */
  selection: EffectiveSelection;
  scanning: Record<number, boolean>;
  scan(chainIds?: number[], manualImports?: ManualImport[]): Promise<void>;
  migration: Migration | null;
  dispatch(e: MigrationEvent): void;
  getMigration(): Migration | null;
  discardMigration(): void;
  /** Rescans the source for a follow-up run. Refused while a transaction is in flight. */
  startNewMigration(): boolean;
  /** Saved Safe profiles for the connected source (validated on load). */
  profiles: SafeProfile[];
  /** Stored profiles that failed validation; kept in storage, never used. */
  profileIssues: LoadedProfiles["rejected"];
  /** The profile the draft is linked to, if any. */
  activeProfile: SafeProfile | null;
  saveProfile(p: SafeProfile, replaces?: string[]): void;
  /** Links the draft to a saved Safe and loads its original owners, threshold and salt. */
  selectProfile(id: string | null): void;
  /** Owner invitations this workspace issued (local nonce registry). */
  invites: OwnerInvite[];
  setInvites(fn: (list: OwnerInvite[]) => OwnerInvite[]): void;
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
  const [profiles, setProfiles] = useState<SafeProfile[]>([]);
  const [profileIssues, setProfileIssues] = useState<LoadedProfiles["rejected"]>([]);
  const profilesRef = useRef<SafeProfile[]>([]);
  const [invites, setInvitesState] = useState<OwnerInvite[]>([]);
  const sourceRef = useRef<Address | null>(null);

  const commitProfiles = useCallback((next: SafeProfile[]) => {
    profilesRef.current = next;
    setProfiles(next);
    const src = sourceRef.current;
    if (src) {
      try {
        saveProfiles(localStorage, src, next);
      } catch {
        // Storage quota: profiles stay in memory for this session.
      }
    }
  }, []);

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
    // Record deployments and verification snapshots on the linked profile as they happen.
    const m = migrationRef.current;
    if (m?.profileId) {
      const p = profilesRef.current.find((x) => x.id === m.profileId);
      if (p) {
        const next = syncProfileWithMigration(p, m);
        if (next !== p) commitProfiles(upsertProfile(profilesRef.current, next));
      }
    }
  }, [commitProfiles]);

  const getMigration = useCallback(() => migrationRef.current, []);

  const pinSource = useCallback(
    (a: Address | null) => {
      setSource(a);
      sourceRef.current = a;
      setDiscovery({});
      if (!a) {
        setInvitesState([]);
        profilesRef.current = [];
        setProfiles([]);
        setProfileIssues([]);
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
      setInvitesState(loadInvites(localStorage, a));
      const loaded = loadProfiles(localStorage, a);
      setProfileIssues(loaded.rejected);
      const records = [...(stored ? [stored] : []), ...loadMigrationHistory(localStorage, a)];
      let withLegacy = loaded.profiles;
      for (const env of ["testnet", "mainnet"] as const) withLegacy = withLegacyProfiles(withLegacy, a, env, records);
      if (withLegacy.length !== loaded.profiles.length) commitProfiles(withLegacy);
      else {
        profilesRef.current = withLegacy;
        setProfiles(withLegacy);
      }
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
    [dispatch, commitProfiles],
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
      const env = new Set(chainsForEnvironment(draftRef.current.environment).map((c) => c.id));
      const ids = (chainIds ?? draftRef.current.selectedChains).filter((id) => env.has(id));
      const imports = importsForChains(manualImports ?? draftRef.current.manualImports, ids);
      setScanning((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, true])) }));
      await Promise.all(
        ids.map(async (chainId) => {
          try {
            const client = getPublicClient(chainId);
            const result = await discoverNetwork({ chainId, owner: source, client, manualImports: imports, fetchIndexer: fetchIndexerViaApi });
            const assets = await enrichWithAdapters({ chainId, source, assets: result.assets, client });
            setDiscovery((d) => ({ ...d, [chainId]: { ...result, assets } }));
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

  const saveProfile = useCallback(
    (p: SafeProfile, replaces: string[] = []) => {
      const drop = new Set(replaces.filter((id) => id !== p.id));
      commitProfiles(upsertProfile(profilesRef.current.filter((x) => !drop.has(x.id)), p));
    },
    [commitProfiles],
  );

  const selectProfile = useCallback(
    (id: string | null) => {
      const p = id ? profilesRef.current.find((x) => x.id === id) : null;
      setDraft((d) => {
        if (!p) return { ...d, profileId: null, saltNonce: null };
        const owners = p.original.owners.map((address, slot) => ({
          slot,
          input: address,
          address,
          ensName: null,
          kind: (source && address.toLowerCase() === source.toLowerCase() ? "connected_eoa" : "independent_wallet") as SignerSlot["kind"],
          label: d.signers.find((s) => s.address?.toLowerCase() === address.toLowerCase())?.label || `Signer ${slot + 1}`,
          verification: d.signers.find((s) => s.address?.toLowerCase() === address.toLowerCase())?.verification ?? null,
        }));
        return { ...d, profileId: p.id, environment: p.environment, signers: owners, threshold: p.original.threshold, saltNonce: p.original.saltNonce };
      });
    },
    [setDraft, source],
  );

  const setInvites = useCallback((fn: (list: OwnerInvite[]) => OwnerInvite[]) => {
    setInvitesState((list) => {
      const next = fn(list);
      const src = sourceRef.current;
      if (src) {
        try {
          saveInvites(localStorage, src, next);
        } catch {
          // Storage quota: invitations stay in memory for this session.
        }
      }
      return next;
    });
  }, []);

  const activeProfile = useMemo(() => profiles.find((p) => p.id === draft.profileId) ?? null, [profiles, draft.profileId]);

  const selection = useMemo(
    () =>
      effectiveSelection({
        envChainIds: chainsForEnvironment(draft.environment).map((c) => c.id),
        selectedChains: draft.selectedChains,
        selectedAssetIds: draft.selectedAssetIds,
        acknowledgedSuspicious: draft.acknowledgedSuspicious,
        discovery,
      }),
    [draft.environment, draft.selectedChains, draft.selectedAssetIds, draft.acknowledgedSuspicious, discovery],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      source,
      pinSource,
      step,
      setStep,
      draft,
      setDraft,
      discovery,
      selection,
      scanning,
      scan,
      migration,
      dispatch,
      getMigration,
      discardMigration,
      startNewMigration,
      profiles,
      profileIssues,
      activeProfile,
      saveProfile,
      selectProfile,
      invites,
      setInvites,
    }),
    [
      source,
      pinSource,
      step,
      draft,
      setDraft,
      discovery,
      selection,
      scanning,
      scan,
      migration,
      dispatch,
      getMigration,
      discardMigration,
      startNewMigration,
      profiles,
      profileIssues,
      activeProfile,
      saveProfile,
      selectProfile,
      invites,
      setInvites,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState outside provider");
  return v;
}
