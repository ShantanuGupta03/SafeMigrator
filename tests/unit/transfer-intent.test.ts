import { describe, expect, it } from "vitest";
import { parseExactDecimalInput, resolveFungiblePlannedAmount, resolveFungibleSendAmount } from "@/lib/domain/transfer-intent";
import { maxNativeTransferable, requiredBalanceForExactNative } from "@/lib/domain/gas-retention";

const ETH = 10n ** 18n;

describe("transfer intent parsing", () => {
  it("parses exact ETH amounts without float math", () => {
    const r = parseExactDecimalInput("0.9", 18);
    expect(r.ok && r.amount).toBe(9n * 10n ** 17n);
  });

  it("rejects scientific notation and excess precision", () => {
    expect(parseExactDecimalInput("1e18", 18).ok).toBe(false);
    expect(parseExactDecimalInput("0.0000001", 6).ok).toBe(false);
  });
});

describe("planned and send resolution", () => {
  it("keeps exact intent fixed at send time", () => {
    const exact = 9n * 10n ** 17n;
    const send = resolveFungibleSendAmount({
      intent: { mode: "exact", amount: exact.toString() },
      previewAmount: exact,
      liveBalance: ETH,
      spendableMax: ETH,
    });
    expect(send.amount).toBe(exact);
    expect(send.blocked).toBeNull();
  });

  it("does not increase max beyond reviewed ceiling when balance grows", () => {
    const ceiling = ETH / 2n;
    const planned = resolveFungiblePlannedAmount({ intent: { mode: "max", ceiling: ceiling.toString() }, liveBalance: ETH, spendableMax: ETH });
    expect(planned.amount).toBe(ceiling);
    const send = resolveFungibleSendAmount({
      intent: { mode: "max", ceiling: ceiling.toString() },
      previewAmount: ceiling,
      liveBalance: ETH,
      spendableMax: ETH,
    });
    expect(send.amount).toBe(ceiling);
  });

  it("blocks exact send when balance drops below reviewed amount", () => {
    const exact = 9n * 10n ** 17n;
    const send = resolveFungibleSendAmount({
      intent: { mode: "exact", amount: exact.toString() },
      previewAmount: exact,
      liveBalance: 8n * 10n ** 17n,
      spendableMax: 8n * 10n ** 17n,
    });
    expect(send.blocked).toMatch(/below/i);
  });
});

describe("native gas retention", () => {
  it("reserves execution cost and extra retain for max native", () => {
    const exec = 10n ** 16n;
    const extra = 5n * 10n ** 15n;
    const max = maxNativeTransferable({ liveBalance: ETH, remainingExecutionCost: exec, extraRetain: extra, reviewedCeiling: ETH });
    expect(max).toBe(ETH - exec - extra);
  });

  it("requires balance cover exact plus reserves", () => {
    const exact = 9n * 10n ** 17n;
    const need = requiredBalanceForExactNative({ exact, remainingExecutionCost: 10n ** 16n, extraRetain: 10n ** 15n });
    expect(need).toBe(exact + 10n ** 16n + 10n ** 15n);
  });
});
