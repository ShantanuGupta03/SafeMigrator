import type { Address, PublicClient } from "viem";
import type { DiscoveredAsset, MigrationAction } from "@/lib/domain/types";
import type { VerifyOutcome } from "../asset-transfer";

/*
 * Extension point for protocol positions. An adapter may turn a "specialized" asset into a
 * transferable one ONLY when it can identify the position from onchain registry reads (never from
 * names or symbols) and prove the move is safe; anything unknown stays specialized. v1.5 ships one
 * adapter (Aave v3 supply positions, beta, off by default). Compound v2/III, LP and staked
 * positions, debt migration, unstaking and rewards claiming are deliberately not implemented: each
 * needs its own identification and risk model ("it is an ERC-20" is not proof a position can move).
 */

export type AdapterId = "aave-v3";

export interface ProtocolContext {
  adapter: AdapterId;
  /** Human market name from the registry, e.g. "Aave v3 Sepolia". */
  market: string;
  pool: Address;
  underlying: Address;
}

export type DebtStatus = { state: "none" } | { state: "present"; detail: string } | { state: "unknown"; detail: string };

export interface ProtocolAdapter {
  id: AdapterId;
  /** Whether the adapter may change classifications in this build. */
  enabled(): boolean;
  /** Re-classifies discovered assets it can positively identify; returns new objects, never mutates. */
  enrich(params: { chainId: number; source: Address; assets: readonly DiscoveredAsset[]; client: PublicClient }): Promise<DiscoveredAsset[]>;
  /** Checked again immediately before submission; anything but `ok` blocks the action. */
  recheck(params: { chainId: number; source: Address; action: MigrationAction; client: PublicClient }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Protocol-aware interpretation of a transfer verification (rounding, accrual). Never hides a real shortfall. */
  interpretVerification(action: MigrationAction, outcome: VerifyOutcome): VerifyOutcome;
}
