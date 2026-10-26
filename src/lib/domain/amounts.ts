import { formatUnits } from "viem";

export const BPS_DENOMINATOR = 10_000n;

/** Multiply by basis points and round UP — used for safety margins. */
export function applyBpsCeil(value: bigint, bps: number | bigint): bigint {
  const b = BigInt(bps);
  if (value < 0n) throw new Error("applyBpsCeil: negative value");
  if (b < 0n) throw new Error("applyBpsCeil: negative bps");
  return (value * b + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

export function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b > a ? b : a));
}

export function minBigInt(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

export function sumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`toBigInt: unsafe number ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value) && !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`toBigInt: not an integer string: ${value}`);
  }
  return BigInt(value);
}

/**
 * Human display of a base-unit amount. Truncates (never rounds up) so the UI
 * never shows more than the user holds.
 */
export function formatAmount(value: bigint | string, decimals: number, maxFractionDigits = 6): string {
  const v = typeof value === "string" ? toBigInt(value) : value;
  const full = formatUnits(v, decimals);
  const [int, frac = ""] = full.split(".");
  const intPart = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  if (!trimmed && v > 0n && (int ?? "0").replace("-", "") === "0") {
    return `<0.${"0".repeat(Math.max(0, maxFractionDigits - 1))}1`;
  }
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

/** Fee display: keeps `significant` digits after leading zeros so tiny testnet fees stay readable. */
export function formatFee(value: bigint | string, decimals: number, significant = 3): string {
  const v = typeof value === "string" ? toBigInt(value) : value;
  if (v <= 0n) return "0";
  const frac = formatUnits(v, decimals).split(".")[1] ?? "";
  const leadingZeros = frac.match(/^0*/)?.[0].length ?? 0;
  return formatAmount(v, decimals, Math.min(decimals, Math.max(6, leadingZeros + significant)));
}

/**
 * Approximate USD value for display only. Uses string math to avoid losing precision on the
 * base-unit amount; the final Number conversion is acceptable because it is never written onchain.
 */
export function approximateUsd(balance: bigint, decimals: number, usdPrice: number | null): number | null {
  if (usdPrice === null || !Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  const units = Number(formatUnits(balance, decimals));
  if (!Number.isFinite(units)) return null;
  return units * usdPrice;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
