import { formatUnits, parseUnits } from "viem";
import type { AssetStandard, BigIntString, DiscoveredAsset } from "./types";
import { toBigInt } from "./amounts";

/**
 * How much of a fungible asset the user intends to move. Stored on the run and used everywhere
 * amounts are planned, reviewed, sent and verified — never UI-only.
 */
export type TransferIntent =
  | { mode: "max"; /** Reviewed ceiling in base units; new deposits above this require re-review. */ ceiling: BigIntString }
  | { mode: "exact"; amount: BigIntString };

export type AssetTransferIntents = Record<string, TransferIntent>;

const SCIENTIFIC = /[eE]/;

/** Default for legacy runs and newly selected assets: move the spendable maximum after reserves. */
export function defaultMaxIntent(balance: BigIntString): TransferIntent {
  return { mode: "max", ceiling: balance };
}

export function intentForAsset(intents: AssetTransferIntents | undefined, asset: Pick<DiscoveredAsset, "id" | "balance">): TransferIntent {
  return intents?.[asset.id] ?? defaultMaxIntent(asset.balance);
}

export function parseExactDecimalInput(raw: string, decimals: number): { ok: true; amount: bigint } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Enter an amount." };
  if (SCIENTIFIC.test(trimmed)) return { ok: false, reason: "Scientific notation is not supported." };
  if (trimmed.startsWith("-")) return { ok: false, reason: "Amount must be positive." };
  if (!/^\d*\.?\d+$/.test(trimmed)) return { ok: false, reason: "Use a decimal number only." };
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return { ok: false, reason: `At most ${decimals} decimal places for this token.` };
  try {
    const amount = parseUnits(`${whole}.${frac}`, decimals);
    if (amount <= 0n) return { ok: false, reason: "Amount must be greater than zero." };
    return { ok: true, amount };
  } catch {
    return { ok: false, reason: "Amount is too large or invalid." };
  }
}

export function validateExactIntent(amount: bigint, balance: bigint, spendableMax: bigint): { ok: true } | { ok: false; reason: string } {
  if (amount <= 0n) return { ok: false, reason: "Amount must be greater than zero." };
  if (amount > balance) return { ok: false, reason: "Amount exceeds wallet balance." };
  if (amount > spendableMax) return { ok: false, reason: "Not enough remains for migration gas and your retention settings." };
  return { ok: true };
}

/** Planned base-unit amount for a fungible transfer at review time. */
export function resolveFungiblePlannedAmount(params: {
  intent: TransferIntent;
  liveBalance: bigint;
  spendableMax: bigint;
}): { amount: bigint; blocked: string | null } {
  const { intent, liveBalance, spendableMax } = params;
  if (intent.mode === "exact") {
    const exact = toBigInt(intent.amount);
    if (liveBalance < exact) return { amount: exact, blocked: "Balance dropped below the exact amount you reviewed. Update the plan." };
    const v = validateExactIntent(exact, liveBalance, spendableMax);
    if (!v.ok) return { amount: exact, blocked: v.reason };
    return { amount: exact, blocked: null };
  }
  const ceiling = toBigInt(intent.ceiling);
  const capped = spendableMax < ceiling ? spendableMax : ceiling;
  if (capped <= 0n) return { amount: 0n, blocked: "Nothing spendable after gas and retention." };
  if (liveBalance < capped && liveBalance < ceiling) {
    return { amount: capped, blocked: "Balance fell below the reviewed maximum. Accept the lower amount or re-review." };
  }
  return { amount: capped, blocked: null };
}

/** At send time: exact stays exact; max may shrink within reviewed ceiling only. */
export function resolveFungibleSendAmount(params: {
  intent: TransferIntent;
  previewAmount: bigint;
  liveBalance: bigint;
  spendableMax: bigint;
}): { amount: bigint; changed: boolean; blocked: string | null } {
  const { intent, previewAmount, liveBalance, spendableMax } = params;
  if (intent.mode === "exact") {
    const exact = toBigInt(intent.amount);
    if (liveBalance < exact) return { amount: exact, changed: false, blocked: "Balance is below the exact reviewed amount." };
    if (exact !== previewAmount) return { amount: exact, changed: true, blocked: "Exact amount drifted from preview; re-review required." };
    return { amount: exact, changed: false, blocked: null };
  }
  const ceiling = toBigInt(intent.ceiling);
  const target = spendableMax < ceiling ? spendableMax : ceiling;
  const changed = target !== previewAmount;
  if (target <= 0n) return { amount: 0n, changed, blocked: "Nothing left to send after reserves." };
  if (target > ceiling) return { amount: target, changed: true, blocked: "Live amount exceeds reviewed ceiling; re-review required." };
  return { amount: target, changed, blocked: changed ? "Spendable maximum changed since review." : null };
}

export function intentSummary(intent: TransferIntent, decimals: number, symbol: string): string {
  if (intent.mode === "exact") return `${formatUnits(toBigInt(intent.amount), decimals)} ${symbol} (exact)`;
  return `Up to ${formatUnits(toBigInt(intent.ceiling), decimals)} ${symbol}`;
}

export function isFungibleAmountEditable(standard: AssetStandard): boolean {
  return standard === "native" || standard === "erc20";
}

/** Legacy migrations without intents: treat full balance as max ceiling from scope or action preview. */
export function legacyIntentFromAction(previewAmount: BigIntString, balance: BigIntString): TransferIntent {
  const p = toBigInt(previewAmount);
  const b = toBigInt(balance);
  if (p > 0n && p < b) return { mode: "exact", amount: previewAmount };
  return { mode: "max", ceiling: previewAmount };
}
