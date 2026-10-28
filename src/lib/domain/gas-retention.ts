import type { BigIntString } from "./types";
import { toBigInt } from "./amounts";

/**
 * Optional extra native balance to keep in the source wallet after migration.
 * Mandatory execution reserve (remaining migration costs + safety margin) is always applied separately.
 */
export interface ChainGasRetention {
  /** When false, only mandatory execution reserve applies (dust may remain). */
  enabled: boolean;
  /** Target minimum native balance after migration completes (base units). */
  extraRetainRaw: BigIntString;
  /** Shuggested value shown to the user; not enforced. */
  suggestedRaw?: BigIntString | null;
}

export type GasRetentionPrefs = {
  /** Apply the same extra-retain target to every selected source network (user may override per chain). */
  applyToAllNetworks: boolean;
  defaultEnabled: boolean;
  perChain: Record<number, ChainGasRetention>;
};

export const DEFAULT_EXTRA_RETAIN_WEI = "500000000000000"; // 0.0005 ETH-class units

export function defaultGasRetention(chainIds: readonly number[]): GasRetentionPrefs {
  const perChain: GasRetentionPrefs["perChain"] = {};
  for (const id of chainIds) {
    perChain[id] = { enabled: true, extraRetainRaw: DEFAULT_EXTRA_RETAIN_WEI, suggestedRaw: DEFAULT_EXTRA_RETAIN_WEI };
  }
  return { applyToAllNetworks: true, defaultEnabled: true, perChain };
}

export function chainRetention(prefs: GasRetentionPrefs | undefined, chainId: number): ChainGasRetention {
  const base = prefs?.perChain[chainId];
  if (base) return base;
  return {
    enabled: prefs?.defaultEnabled ?? true,
    extraRetainRaw: DEFAULT_EXTRA_RETAIN_WEI,
    suggestedRaw: DEFAULT_EXTRA_RETAIN_WEI,
  };
}

/** Extra native to retain after migration; zero when disabled or prefs absent (legacy runs). */
export function extraRetainAmount(prefs: GasRetentionPrefs | undefined, chainId: number): bigint {
  if (!prefs) return 0n;
  const c = chainRetention(prefs, chainId);
  return c.enabled ? toBigInt(c.extraRetainRaw) : 0n;
}

/**
 * Max native transferable after reserving remaining execution costs and optional extra retention.
 * Includes the native transfer's own fee in `remainingExecutionCost`.
 */
export function maxNativeTransferable(params: {
  liveBalance: bigint;
  remainingExecutionCost: bigint;
  extraRetain: bigint;
  reviewedCeiling: bigint;
}): bigint {
  const reserve = params.remainingExecutionCost + params.extraRetain;
  const spendable = params.liveBalance > reserve ? params.liveBalance - reserve : 0n;
  return spendable < params.reviewedCeiling ? spendable : params.reviewedCeiling;
}

/** Minimum balance required to send an exact native amount. */
export function requiredBalanceForExactNative(params: { exact: bigint; remainingExecutionCost: bigint; extraRetain: bigint }): bigint {
  return params.exact + params.remainingExecutionCost + params.extraRetain;
}
