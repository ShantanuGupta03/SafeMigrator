import { describe, expect, it } from "vitest";
import { applyBpsCeil, approximateUsd, formatAmount, formatFee, formatUsd, sumBigInt, toBigInt } from "@/lib/domain/amounts";
import { isDust, maxCost, spendableNative, typicalCost, type FeeQuote } from "@/lib/services/gas-estimation";

describe("amount helpers", () => {
  it("applies basis-point margins with ceiling rounding", () => {
    expect(applyBpsCeil(100n, 12_000)).toBe(120n);
    expect(applyBpsCeil(1n, 12_000)).toBe(2n);
    expect(applyBpsCeil(0n, 12_000)).toBe(0n);
  });

  it("formats base units without floating-point rounding up", () => {
    expect(formatAmount(1_999_999n, 6, 2)).toBe("1.99");
    expect(formatAmount("123456789012345678901234567890", 18, 4)).toBe("123,456,789,012.3456");
    expect(formatAmount(0n, 18)).toBe("0");
  });

  it("keeps significant digits for tiny fees", () => {
    expect(formatFee(1_234_567_000n, 18)).toBe("0.00000000123");
    expect(formatFee(2_500_000_000_000_000n, 18)).toBe("0.0025");
    expect(formatFee(0n, 18)).toBe("0");
  });

  it("parses BigInt strings defensively", () => {
    expect(toBigInt("42")).toBe(42n);
    expect(toBigInt(null)).toBe(0n);
    expect(sumBigInt([1n, 2n, 3n])).toBe(6n);
  });

  it("only prices assets with a real price", () => {
    expect(approximateUsd(2_000_000n, 6, 1)).toBeCloseTo(2);
    expect(approximateUsd(2_000_000n, 6, null)).toBeNull();
    expect(approximateUsd(2_000_000n, 6, 0)).toBeNull();
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0.001)).toBe("<$0.01");
  });
});

describe("gas math", () => {
  const fee: FeeQuote = { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, currentGasPrice: 10n, eip1559: true };

  it("computes worst-case and typical cost including L1 data fee", () => {
    expect(maxCost(21_000n, fee)).toBe(630_000n);
    expect(maxCost(21_000n, fee, 5n)).toBe(630_005n);
    expect(typicalCost(21_000n, fee)).toBe(210_000n);
  });

  it("never returns a negative spendable amount", () => {
    expect(spendableNative(100n, 30n)).toBe(70n);
    expect(spendableNative(10n, 30n)).toBe(0n);
  });

  it("treats transfers worth less than N× their fee as dust", () => {
    expect(isDust(0n, 1n, 3)).toBe(true);
    expect(isDust(29n, 10n, 3)).toBe(true);
    expect(isDust(30n, 10n, 3)).toBe(false);
  });
});
