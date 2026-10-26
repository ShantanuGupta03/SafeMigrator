/**
 * Read-only JSON-RPC methods the server proxy will forward. Anything that could sign or
 * broadcast (eth_sendRawTransaction, eth_sign, personal_*, wallet_*) is rejected: all writes go
 * through the user's own wallet.
 */
export const ALLOWED_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

export const MAX_BATCH_SIZE = 50;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export type ValidationResult =
  | { ok: true; requests: JsonRpcRequest[]; isBatch: boolean }
  | { ok: false; status: number; error: string };

export function validateRpcPayload(body: unknown): ValidationResult {
  const isBatch = Array.isArray(body);
  const items = (isBatch ? body : [body]) as unknown[];
  if (items.length === 0) return { ok: false, status: 400, error: "Empty request" };
  if (items.length > MAX_BATCH_SIZE) return { ok: false, status: 413, error: "Batch too large" };
  const requests: JsonRpcRequest[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return { ok: false, status: 400, error: "Invalid JSON-RPC request" };
    const req = item as Record<string, unknown>;
    if (typeof req.method !== "string") return { ok: false, status: 400, error: "Missing method" };
    if (!ALLOWED_RPC_METHODS.has(req.method)) {
      return { ok: false, status: 403, error: `Method not allowed: ${req.method}` };
    }
    requests.push({
      jsonrpc: "2.0",
      id: (req.id as number | string | null) ?? null,
      method: req.method,
      params: req.params,
    });
  }
  return { ok: true, requests, isBatch };
}
