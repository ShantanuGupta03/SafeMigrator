import { describe, expect, it, vi } from "vitest";
import {
  buildSendCallsParams,
  getAtomicCapabilities,
  interpretCallsStatus,
  parseCapabilities,
  sendAtomicBatch,
  strategyFor,
  waitForCallsStatus,
  type Eip1193Requester,
} from "@/lib/services/transaction-capability";
import { SAFE, SEPOLIA, SOURCE, CHIADO, TOKEN } from "./fixtures";

// These tests use MOCKED wallet responses to exercise parsing and control flow only.
// They are not evidence of a real onchain batch.

describe("EIP-5792 capability parsing (mocked responses)", () => {
  it("reads per-chain atomic status", () => {
    const caps = parseCapabilities({ "0xaa36a7": { atomic: { status: "supported" } }, "0x27d8": { atomic: { status: "unsupported" } } }, [SEPOLIA, CHIADO]);
    expect(caps[SEPOLIA]!.atomic).toBe("supported");
    expect(caps[CHIADO]!.atomic).toBe("unsupported");
    expect(strategyFor(caps[SEPOLIA])).toBe("atomic_batch");
    expect(strategyFor(caps[CHIADO])).toBe("sequential");
  });

  it("applies 0x0 capabilities to all chains", () => {
    const caps = parseCapabilities({ "0x0": { atomic: { status: "ready" } } }, [SEPOLIA, CHIADO]);
    expect(caps[SEPOLIA]).toMatchObject({ atomic: "ready", source: "wallet_global" });
    expect(strategyFor(caps[CHIADO])).toBe("atomic_batch");
  });

  it("does not treat pre-final atomicBatch as atomic support", () => {
    const caps = parseCapabilities({ "0xaa36a7": { atomicBatch: { supported: true } } }, [SEPOLIA]);
    expect(caps[SEPOLIA]!.atomic).toBe("unsupported");
    expect(caps[SEPOLIA]!.note).toMatch(/pre-final/);
  });

  it("ignores malformed responses", () => {
    expect(parseCapabilities(null, [SEPOLIA])[SEPOLIA]!.atomic).toBe("unsupported");
    expect(parseCapabilities({ "0xaa36a7": { atomic: { status: "yes" } } }, [SEPOLIA])[SEPOLIA]!.atomic).toBe("unsupported");
  });

  it("falls back to unsupported when wallet_getCapabilities errors", async () => {
    const provider: Eip1193Requester = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    const caps = await getAtomicCapabilities(provider, SOURCE, [SEPOLIA]);
    expect(caps[SEPOLIA]).toMatchObject({ atomic: "unsupported", source: "error" });
  });
});

describe("wallet_sendCalls payload", () => {
  it("requires atomicity and hex-encodes chain and values", () => {
    const [p] = buildSendCallsParams(SEPOLIA, SOURCE, [
      { to: TOKEN, data: "0xa9059cbb", value: 0n },
      { to: SAFE, data: "0x", value: 10n },
    ]);
    expect(p).toMatchObject({ version: "2.0.0", chainId: "0xaa36a7", from: SOURCE, atomicRequired: true });
    expect(p!.calls[1]).toEqual({ to: SAFE, data: "0x", value: "0xa" });
    expect(() => buildSendCallsParams(SEPOLIA, SOURCE, [])).toThrow();
  });

  it("accepts both {id} and legacy string responses", async () => {
    expect(await sendAtomicBatch({ request: async () => ({ id: "0xabc" }) }, SEPOLIA, SOURCE, [{ to: SAFE, data: "0x", value: 1n }])).toBe("0xabc");
    expect(await sendAtomicBatch({ request: async () => "0xdef" }, SEPOLIA, SOURCE, [{ to: SAFE, data: "0x", value: 1n }])).toBe("0xdef");
    await expect(sendAtomicBatch({ request: async () => ({}) }, SEPOLIA, SOURCE, [{ to: SAFE, data: "0x", value: 1n }])).rejects.toThrow();
  });
});

describe("wallet_getCallsStatus interpretation (mocked responses)", () => {
  const receipt = (status: string) => ({ transactionHash: `0x${"1".repeat(64)}`, status, blockNumber: "0x10" });

  it("maps status codes", () => {
    expect(interpretCallsStatus({ status: 100 })).toEqual({ state: "pending" });
    expect(interpretCallsStatus({ status: 200, atomic: true, receipts: [receipt("0x1")] })).toMatchObject({ state: "confirmed", atomic: true });
    expect(interpretCallsStatus({ status: 400 })).toMatchObject({ state: "failed_offchain", code: 400 });
    expect(interpretCallsStatus({ status: 500, receipts: [receipt("0x0")] })).toMatchObject({ state: "reverted" });
    expect(interpretCallsStatus({ status: 600, receipts: [] })).toMatchObject({ state: "partial" });
    expect(interpretCallsStatus({ status: 999 })).toMatchObject({ state: "unknown" });
    expect(interpretCallsStatus("nonsense")).toMatchObject({ state: "unknown" });
  });

  it("treats a 200 with a reverted receipt as partial, never as success", () => {
    expect(interpretCallsStatus({ status: 200, atomic: false, receipts: [receipt("0x1"), receipt("0x0")] }).state).toBe("partial");
  });

  it("polls until a final status", async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: 100 }).mockResolvedValueOnce({ status: 100 }).mockResolvedValueOnce({ status: 200, atomic: true, receipts: [] });
    const out = await waitForCallsStatus({ request }, "0xabc", { sleep: async () => {}, intervalMs: 1, timeoutMs: 100 });
    expect(out.state).toBe("confirmed");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("reports pending (not success) when it times out", async () => {
    const out = await waitForCallsStatus({ request: async () => ({ status: 100 }) }, "0xabc", { sleep: async () => {}, intervalMs: 10, timeoutMs: 30 });
    expect(out.state).toBe("pending");
  });
});
