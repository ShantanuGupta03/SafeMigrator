"use client";

import { useEffect, useMemo, useState } from "react";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment, getChain } from "@/lib/chains/registry";
import type { SafeProfile } from "@/lib/domain/profile";
import type { ChainSafeTarget, SafeConfig, SupportedSafeVersion } from "@/lib/domain/types";
import { negotiateSafeVersion, resolveChainTarget } from "@/lib/services/safe-deployment";
import { isPinned, profileMatchesConfig, resolvePinnedTarget } from "@/lib/services/safe-profile";
import { buildSafeConfig, deriveSaltNonce, safeConfigHash, validateSigners } from "@/lib/services/signer-configuration";
import { useAppState } from "../app-state";

/** Current Safe configuration derived from the draft, or null while signers are invalid. */
export function useSafeConfig() {
  const { draft, source } = useAppState();
  return useMemo(() => {
    const issues = validateSigners(draft.signers, draft.threshold);
    if (issues.length || !source) return { config: null, configHash: null, issues };
    const config = buildSafeConfig(
      draft.signers.map((s) => s.address!),
      draft.threshold,
      draft.saltNonce ?? deriveSaltNonce(source, draft.saltVariant),
    );
    return { config, configHash: safeConfigHash(config), issues };
  }, [draft.signers, draft.threshold, draft.saltVariant, draft.saltNonce, source]);
}

/**
 * The saved profile whose pinned recipe governs the current configuration, if any. A profile is
 * only used when the draft reproduces its original owners, threshold and salt exactly.
 */
export function usePinnedProfile(): SafeProfile | null {
  const { activeProfile } = useAppState();
  const { config } = useSafeConfig();
  return useMemo(() => (activeProfile && isPinned(activeProfile) && profileMatchesConfig(activeProfile, config) ? activeProfile : null), [activeProfile, config]);
}

/** Signers whose signature is bound to the *current* configuration. */
export function useVerifiedOwners() {
  const { draft } = useAppState();
  const { configHash } = useSafeConfig();
  return useMemo(
    () => draft.signers.filter((s) => s.address && s.verification && s.verification.configHash === configHash).map((s) => s.address!),
    [draft.signers, configHash],
  );
}

export interface TargetsState {
  loading: boolean;
  commonVersion: SupportedSafeVersion | null;
  targets: Record<number, ChainSafeTarget>;
  error: string | null;
  /** Targets come from a saved profile's pinned recipe; no version negotiation happened. */
  pinnedProfileId: string | null;
}

/**
 * Resolves the Safe on each requested chain.
 *
 * * Saved profile (pinned): every chain is resolved from the recipe alone. Nothing is negotiated, so
 *   registry changes or an unreachable chain can never move the address.
 * * New configuration: one version is negotiated across ALL networks of the environment (so the
 *   address does not change with the selection). If any network is unreachable the version is left
 *   undecided rather than chosen from a subset.
 */
export function useSafeTargets(config: SafeConfig | null, chainIds: number[], nonce = 0): TargetsState {
  const { draft } = useAppState();
  const pinned = usePinnedProfile();
  const [result, setResult] = useState<{ key: string; state: TargetsState } | null>(null);
  const key = config ? `${safeConfigHash(config)}:${chainIds.join(",")}:${draft.environment}:${pinned?.commitment ?? "-"}:${nonce}` : null;

  useEffect(() => {
    if (!config || !key) return;
    let cancelled = false;
    (async () => {
      let state: TargetsState;
      try {
        if (pinned) {
          const entries = await Promise.all(chainIds.map(async (id) => [id, await resolvePinnedTarget(id, getPublicClient(id), pinned)] as const));
          state = { loading: false, commonVersion: pinned.recipe!.safeVersion, targets: Object.fromEntries(entries), error: null, pinnedProfileId: pinned.id };
        } else {
          const envChains = chainsForEnvironment(draft.environment).map((c) => c.id);
          const negotiation = await negotiateSafeVersion([...new Set([...envChains, ...chainIds])], getPublicClient);
          const entries = await Promise.all(
            chainIds.map(async (id) => [id, await resolveChainTarget(id, getPublicClient(id), config, negotiation.perChain[id]!)] as const),
          );
          const targets = Object.fromEntries(entries.map(([id, t]) => [id, negotiation.unavailable.length ? { ...t, status: "error" as const, unavailable: true } : t]));
          const error = negotiation.unavailable.length
            ? `Could not reach ${negotiation.unavailable.map((id) => getChain(id).name).join(", ")} to verify the Safe contracts. The shared Safe address depends on every network in this environment, so it is not shown until all of them can be read. Retry in a moment.`
            : null;
          state = { loading: false, commonVersion: negotiation.commonVersion, targets, error, pinnedProfileId: null };
        }
      } catch (e) {
        state = { loading: false, commonVersion: null, targets: {}, error: (e as Error).message, pinnedProfileId: null };
      }
      if (!cancelled) setResult({ key, state });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useMemo<TargetsState>(() => {
    if (!key) return EMPTY_TARGETS;
    if (result?.key === key) return result.state;
    return { ...EMPTY_TARGETS, loading: true };
  }, [key, result]);
}

const EMPTY_TARGETS: TargetsState = { loading: false, commonVersion: null, targets: {}, error: null, pinnedProfileId: null };
