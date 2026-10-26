"use client";

import { useEffect, useMemo, useState } from "react";
import { getPublicClient } from "@/lib/chains/clients";
import { chainsForEnvironment } from "@/lib/chains/registry";
import type { ChainSafeTarget, SafeConfig, SupportedSafeVersion } from "@/lib/domain/types";
import { negotiateSafeVersion, resolveChainTarget } from "@/lib/services/safe-deployment";
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
      deriveSaltNonce(source, draft.saltVariant),
    );
    return { config, configHash: safeConfigHash(config), issues };
  }, [draft.signers, draft.threshold, draft.saltVariant, source]);
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
}

/**
 * Negotiates one Safe version across all executable networks of the environment (so the address
 * does not change when the selection changes), then predicts and inspects each requested chain.
 */
export function useSafeTargets(config: SafeConfig | null, chainIds: number[], nonce = 0): TargetsState {
  const { draft } = useAppState();
  const [result, setResult] = useState<{ key: string; state: TargetsState } | null>(null);
  const key = config ? `${safeConfigHash(config)}:${chainIds.join(",")}:${draft.environment}:${nonce}` : null;

  useEffect(() => {
    if (!config || !key) return;
    let cancelled = false;
    (async () => {
      let state: TargetsState;
      try {
        const envChains = chainsForEnvironment(draft.environment).map((c) => c.id);
        const negotiation = await negotiateSafeVersion([...new Set([...envChains, ...chainIds])], getPublicClient);
        const entries = await Promise.all(
          chainIds.map(async (id) => [id, await resolveChainTarget(id, getPublicClient(id), config, negotiation.perChain[id]!)] as const),
        );
        state = { loading: false, commonVersion: negotiation.commonVersion, targets: Object.fromEntries(entries), error: null };
      } catch (e) {
        state = { loading: false, commonVersion: null, targets: {}, error: (e as Error).message };
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

const EMPTY_TARGETS: TargetsState = { loading: false, commonVersion: null, targets: {}, error: null };
