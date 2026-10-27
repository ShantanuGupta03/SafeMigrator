import type { Page } from "@playwright/test";
import type { Hex, PrivateKeyAccount, TypedDataDefinition } from "viem";

/**
 * A test-only injected wallet (EIP-1193) backed by a throwaway viem account in the Node test
 * process. It answers account/chain queries and signs EIP-712 messages. Every other wallet method,
 * including eth_sendTransaction, is recorded and refused, so a test can assert that a flow never
 * asked for a transaction.
 */
export async function installMockWallet(page: Page, account: PrivateKeyAccount, chainId = 11155111, opts: { rpcFor?: (chainId: number) => string } = {}) {
  const requests: string[] = [];
  await page.exposeFunction("__smSignTypedData", async (json: string) => signTypedJson(account, json));
  // Only when a test passes local RPCs: transactions are signed in Node and sent to local test chains.
  await page.exposeFunction("__smSendTransaction", async (chain: number, tx: Record<string, string>) => {
    if (!opts.rpcFor) throw Object.assign(new Error("Mock wallet refuses transactions"), { code: 4001 });
    const { createWalletClient, http } = await import("viem");
    const { getChain } = await import("@/lib/chains/registry");
    const w = createWalletClient({ account, chain: getChain(chain).viemChain, transport: http(opts.rpcFor(chain)) });
    const big = (v?: string) => (v === undefined ? undefined : BigInt(v));
    return w.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: big(tx.value), gas: big(tx.gas), maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) } as never);
  });
  await page.exposeFunction("__smRecord", (method: string) => {
    requests.push(method);
  });
  await page.addInitScript(
    ({ address, chainId }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let current = chainId;
      const w = window as unknown as {
        __smSignTypedData(j: string): Promise<string>;
        __smSendTransaction(chain: number, tx: unknown): Promise<string>;
        __smRecord(m: string): void;
      };
      const emit = (e: string, v: unknown) => (listeners[e] ?? []).forEach((fn) => fn(v));
      const provider = {
        isMetaMask: false,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          void w.__smRecord(method === "eth_sendTransaction" ? `${method}:${current}:${(params?.[0] as { to?: string })?.to ?? ""}` : method);
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return `0x${current.toString(16)}`;
            case "wallet_switchEthereumChain": {
              current = Number.parseInt((params?.[0] as { chainId: string }).chainId, 16);
              emit("chainChanged", `0x${current.toString(16)}`);
              return null;
            }
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "eth_signTypedData_v4":
              return w.__smSignTypedData(params?.[1] as string);
            case "eth_sendTransaction":
              return w.__smSendTransaction(current, params?.[0]);
            default:
              throw Object.assign(new Error(`Mock wallet does not support ${method}`), { code: 4200 });
          }
        },
        on: (e: string, fn: (...a: unknown[]) => void) => {
          (listeners[e] ??= []).push(fn);
        },
        removeListener: () => {},
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    },
    { address: account.address, chainId },
  );
  return requests;
}

/** eth_signTypedData_v4 JSON → viem typed data (uint fields back to bigint, EIP712Domain dropped). */
async function signTypedJson(account: PrivateKeyAccount, json: string): Promise<Hex> {
  const data = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  const { EIP712Domain: _domain, ...types } = data.types;
  void _domain;
  const convert = (type: string, value: unknown): unknown => {
    if (type.endsWith("[]")) return (value as unknown[]).map((v) => convert(type.slice(0, -2), v));
    if (/^u?int\d*$/.test(type)) return BigInt(value as string);
    const struct = types[type];
    if (struct) return Object.fromEntries(struct.map((f) => [f.name, convert(f.type, (value as Record<string, unknown>)[f.name])]));
    return value;
  };
  const domain = { ...data.domain, ...(data.domain.chainId !== undefined ? { chainId: Number(data.domain.chainId) } : {}) };
  return account.signTypedData({ domain, types, primaryType: data.primaryType, message: convert(data.primaryType, data.message) } as unknown as TypedDataDefinition);
}

/** Funds an address on a local test chain (Hardhat). */
export async function setBalance(rpcUrl: string, address: string, wei: bigint) {
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hardhat_setBalance", params: [address, `0x${wei.toString(16)}`] }),
  });
}
