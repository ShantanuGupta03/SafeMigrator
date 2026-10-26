import { toHex, type Address, type Hex } from "viem";
import type { ExecutionStrategy } from "@/lib/domain/types";

/** Minimal EIP-1193 surface; lets tests inject mocked wallets. */
export interface Eip1193Requester {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export type AtomicStatus = "supported" | "ready" | "unsupported";

export interface ChainCapability {
  chainId: number;
  atomic: AtomicStatus;
  /** Where the answer came from. "error" = wallet_getCapabilities failed (treated as unsupported). */
  source: "wallet" | "wallet_global" | "not_reported" | "error";
  note: string | null;
}

const VALID_ATOMIC = new Set<AtomicStatus>(["supported", "ready", "unsupported"]);

function parseChainKey(key: string): number | null {
  try {
    const n = Number(BigInt(key));
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function readAtomic(entry: unknown): { status: AtomicStatus | null; legacy: boolean } {
  if (!entry || typeof entry !== "object") return { status: null, legacy: false };
  const e = entry as Record<string, unknown>;
  const atomic = e.atomic as { status?: unknown } | undefined;
  if (atomic && typeof atomic.status === "string" && VALID_ATOMIC.has(atomic.status as AtomicStatus)) {
    return { status: atomic.status as AtomicStatus, legacy: false };
  }
  const legacy = e.atomicBatch as { supported?: unknown } | undefined;
  return { status: null, legacy: legacy?.supported === true };
}

/**
 * Parses a wallet_getCapabilities response per EIP-5792. Capabilities under "0x0" apply to every
 * chain. Pre-final `atomicBatch` responses are NOT treated as atomic support, because the
 * final spec's `atomicRequired` guarantee cannot be assumed for them.
 */
export function parseCapabilities(response: unknown, chainIds: readonly number[]): Record<number, ChainCapability> {
  const out: Record<number, ChainCapability> = {};
  const byChain = new Map<number, unknown>();
  let global: unknown = undefined;
  if (response && typeof response === "object") {
    for (const [k, v] of Object.entries(response as Record<string, unknown>)) {
      const id = parseChainKey(k);
      if (id === 0) global = v;
      else if (id !== null) byChain.set(id, v);
    }
  }
  const g = readAtomic(global);
  for (const chainId of chainIds) {
    const c = readAtomic(byChain.get(chainId));
    if (c.status) {
      out[chainId] = { chainId, atomic: c.status, source: "wallet", note: null };
    } else if (g.status) {
      out[chainId] = { chainId, atomic: g.status, source: "wallet_global", note: null };
    } else {
      out[chainId] = {
        chainId,
        atomic: "unsupported",
        source: "not_reported",
        note: c.legacy || g.legacy ? "Wallet reports a pre-final batching capability; using sequential transactions." : null,
      };
    }
  }
  return out;
}

export async function getAtomicCapabilities(
  provider: Eip1193Requester,
  account: Address,
  chainIds: readonly number[],
): Promise<Record<number, ChainCapability>> {
  try {
    const res = await provider.request({ method: "wallet_getCapabilities", params: [account, chainIds.map((id) => toHex(id))] });
    return parseCapabilities(res, chainIds);
  } catch (e) {
    const note = `Wallet does not support EIP-5792 capability discovery (${(e as Error).message?.slice(0, 80) ?? "error"}).`;
    return Object.fromEntries(chainIds.map((id) => [id, { chainId: id, atomic: "unsupported", source: "error", note }]));
  }
}

export function strategyFor(cap: ChainCapability | undefined): ExecutionStrategy {
  return cap && (cap.atomic === "supported" || cap.atomic === "ready") ? "atomic_batch" : "sequential";
}

export interface BatchCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export function buildSendCallsParams(chainId: number, from: Address, calls: readonly BatchCall[]) {
  if (calls.length === 0) throw new Error("Empty batch");
  return [
    {
      version: "2.0.0",
      chainId: toHex(chainId),
      from,
      atomicRequired: true,
      calls: calls.map((c) => ({ to: c.to, data: c.data, value: toHex(c.value) })),
    },
  ];
}

export async function sendAtomicBatch(
  provider: Eip1193Requester,
  chainId: number,
  from: Address,
  calls: readonly BatchCall[],
): Promise<string> {
  const res = await provider.request({ method: "wallet_sendCalls", params: buildSendCallsParams(chainId, from, calls) });
  if (typeof res === "string") return res;
  if (res && typeof res === "object" && typeof (res as { id?: unknown }).id === "string") return (res as { id: string }).id;
  throw new Error("wallet_sendCalls returned no batch id");
}

export interface CallsReceipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint | null;
}

export type BatchOutcome =
  | { state: "pending" }
  | { state: "confirmed"; atomic: boolean; receipts: CallsReceipt[] }
  | { state: "failed_offchain"; code: number }
  | { state: "reverted"; code: number; receipts: CallsReceipt[] }
  | { state: "partial"; code: number; receipts: CallsReceipt[] }
  | { state: "unknown"; code: number | null };

function parseReceipts(raw: unknown): CallsReceipt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object" && typeof (r as { transactionHash?: unknown }).transactionHash === "string")
    .map((r) => {
      const rec = r as { transactionHash: Hex; status?: string; blockNumber?: string };
      return {
        transactionHash: rec.transactionHash,
        status: rec.status === "0x1" || rec.status === "success" ? "success" : "reverted",
        blockNumber: rec.blockNumber ? BigInt(rec.blockNumber) : null,
      };
    });
}

/** Maps EIP-5792 status codes: 1xx pending, 200 confirmed, 4xx offchain failure, 500 reverted, 600 partial. */
export function interpretCallsStatus(res: unknown): BatchOutcome {
  if (!res || typeof res !== "object") return { state: "unknown", code: null };
  const r = res as { status?: unknown; atomic?: unknown; receipts?: unknown };
  const receipts = parseReceipts(r.receipts);
  let code: number | null = typeof r.status === "number" ? r.status : null;
  if (code === null && typeof r.status === "string") {
    // Pre-final string statuses.
    code = r.status.toUpperCase() === "PENDING" ? 100 : r.status.toUpperCase() === "CONFIRMED" ? 200 : null;
  }
  if (code === null) return { state: "unknown", code: null };
  if (code >= 100 && code < 200) return { state: "pending" };
  if (code === 200) {
    if (receipts.some((x) => x.status === "reverted")) return { state: "partial", code, receipts };
    return { state: "confirmed", atomic: r.atomic === true, receipts };
  }
  if (code >= 400 && code < 500) return { state: "failed_offchain", code };
  if (code >= 500 && code < 600) return { state: "reverted", code, receipts };
  if (code >= 600 && code < 700) return { state: "partial", code, receipts };
  return { state: "unknown", code };
}

export async function waitForCallsStatus(
  provider: Eip1193Requester,
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BatchOutcome> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const interval = opts.intervalMs ?? 2_500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let lastError: unknown = null;
  let elapsed = 0;
  while (elapsed <= timeout) {
    try {
      const outcome = interpretCallsStatus(await provider.request({ method: "wallet_getCallsStatus", params: [id] }));
      if (outcome.state !== "pending") return outcome;
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
    elapsed = opts.sleep ? elapsed + interval : Date.now() - started;
  }
  if (lastError) return { state: "unknown", code: null };
  return { state: "pending" };
}
