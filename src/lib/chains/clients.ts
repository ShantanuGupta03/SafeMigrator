import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { getChain } from "./registry";

/**
 * Browser: route reads through our read-only proxy so provider credentials stay server-side.
 * Node (tests/scripts): talk to public RPCs directly.
 */
export function rpcUrlFor(chainId: number): string {
  if (typeof window !== "undefined") return `${window.location.origin}/api/rpc/${chainId}`;
  return getChain(chainId).publicRpcUrls[0]!;
}

const cache = new Map<number, PublicClient>();

export function getPublicClient(chainId: number): PublicClient {
  const existing = cache.get(chainId);
  if (existing) return existing;
  const chain = getChain(chainId);
  const transport =
    typeof window !== "undefined"
      ? http(rpcUrlFor(chainId), { batch: { wait: 16 }, retryCount: 2 })
      : fallback(chain.publicRpcUrls.map((u) => http(u, { retryCount: 1 })));
  const client = createPublicClient({ chain: chain.viemChain, transport }) as PublicClient;
  cache.set(chainId, client);
  return client;
}

export type PublicClientResolver = (chainId: number) => PublicClient;
