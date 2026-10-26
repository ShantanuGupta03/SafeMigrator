import { getAddress, isAddress, type Address } from "viem";
import { findChain } from "@/lib/chains/registry";
import type { IndexedToken, IndexerResponse } from "@/lib/services/discovery/indexer-types";

const MAX_PAGES = 4;
const TIMEOUT_MS = 12_000;

function emptyResponse(provider: string, chainId: number, supported: boolean, errors: string[] = []): IndexerResponse {
  return {
    provider,
    chainId,
    supported,
    tokens: [],
    nativeUsdPrice: null,
    truncated: false,
    errors,
    covers: { erc20: false, erc721: false, erc1155: false },
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeAddr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* -------------------------------- Blockscout ------------------------------- */

interface BlockscoutToken {
  address_hash?: string;
  address?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  exchange_rate?: string | null;
  icon_url?: string | null;
  reputation?: string | null;
  type?: string;
}

async function blockscoutPages<T>(base: string, path: string, query: Record<string, string>): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let params: Record<string, string> | null = query;
  for (let page = 0; page < MAX_PAGES && params; page++) {
    const qs = new URLSearchParams(params).toString();
    const data = (await getJson(`${base}${path}?${qs}`)) as { items?: T[]; next_page_params?: Record<string, unknown> | null };
    items.push(...(data.items ?? []));
    params = data.next_page_params
      ? { ...query, ...Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])) }
      : null;
  }
  return { items, truncated: params !== null };
}

export async function blockscoutDiscover(chainId: number, owner: Address): Promise<IndexerResponse> {
  const chain = findChain(chainId);
  if (!chain?.blockscoutUrl) return emptyResponse("blockscout", chainId, false, ["Blockscout is not configured for this network."]);
  const base = chain.blockscoutUrl;
  const res = emptyResponse("blockscout", chainId, true);
  const isScam = (t: BlockscoutToken) => !!t.reputation && t.reputation !== "ok";

  const [erc20, nfts, stats] = await Promise.allSettled([
    blockscoutPages<{ token: BlockscoutToken; value: string }>(base, `/api/v2/addresses/${owner}/tokens`, { type: "ERC-20" }),
    blockscoutPages<{ id: string; value: string; token: BlockscoutToken; image_url?: string | null; token_type?: string }>(
      base,
      `/api/v2/addresses/${owner}/nft`,
      { type: "ERC-721,ERC-1155" },
    ),
    getJson(`${base}/api/v2/stats`) as Promise<{ coin_price?: string | null }>,
  ]);

  if (erc20.status === "fulfilled") {
    res.covers.erc20 = true;
    res.truncated ||= erc20.value.truncated;
    for (const item of erc20.value.items) {
      const contract = safeAddr(item.token.address_hash ?? item.token.address);
      if (!contract) continue;
      res.tokens.push({
        standard: "erc20",
        contract,
        tokenId: null,
        balance: String(item.value ?? "0"),
        name: item.token.name ?? null,
        symbol: item.token.symbol ?? null,
        decimals: num(item.token.decimals),
        usdPrice: num(item.token.exchange_rate),
        imageUrl: item.token.icon_url ?? null,
        indexerSpam: isScam(item.token),
      });
    }
  } else {
    res.errors.push(`ERC-20 index unavailable: ${String(erc20.reason?.message ?? erc20.reason)}`);
  }

  if (nfts.status === "fulfilled") {
    res.covers.erc721 = true;
    res.covers.erc1155 = true;
    res.truncated ||= nfts.value.truncated;
    for (const item of nfts.value.items) {
      const contract = safeAddr(item.token.address_hash ?? item.token.address);
      const type = item.token_type ?? item.token.type;
      if (!contract || (type !== "ERC-721" && type !== "ERC-1155") || !/^\d+$/.test(String(item.id))) continue;
      res.tokens.push({
        standard: type === "ERC-721" ? "erc721" : "erc1155",
        contract,
        tokenId: String(item.id),
        balance: String(item.value ?? "1"),
        name: item.token.name ?? null,
        symbol: item.token.symbol ?? null,
        decimals: 0,
        usdPrice: null,
        imageUrl: item.image_url ?? null,
        indexerSpam: isScam(item.token),
      });
    }
  } else {
    res.errors.push(`NFT index unavailable: ${String(nfts.reason?.message ?? nfts.reason)}`);
  }

  if (stats.status === "fulfilled" && chain.environment === "mainnet") {
    res.nativeUsdPrice = num(stats.value.coin_price);
  }
  return res;
}

/* --------------------------------- Alchemy -------------------------------- */

export async function alchemyDiscover(chainId: number, owner: Address, apiKey: string): Promise<IndexerResponse> {
  const chain = findChain(chainId);
  if (!chain?.alchemyNetwork) return emptyResponse("alchemy", chainId, false, ["Alchemy does not index this network."]);
  const rpc = `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${apiKey}`;
  const nftBase = `https://${chain.alchemyNetwork}.g.alchemy.com/nft/v3/${apiKey}`;
  const res = emptyResponse("alchemy", chainId, true);
  const call = async (method: string, params: unknown[]) => {
    const data = (await getJson(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })) as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result;
  };

  try {
    let pageKey: string | undefined;
    const balances: { contractAddress: string; tokenBalance: string }[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await call("alchemy_getTokenBalances", [owner, "erc20", ...(pageKey ? [{ pageKey }] : [])])) as {
        tokenBalances: { contractAddress: string; tokenBalance: string }[];
        pageKey?: string;
      };
      balances.push(...r.tokenBalances);
      pageKey = r.pageKey;
      if (!pageKey) break;
    }
    res.truncated ||= !!pageKey;
    res.covers.erc20 = true;
    const nonZero = balances.filter((b) => b.tokenBalance && BigInt(b.tokenBalance) > 0n).slice(0, 150);
    const metas = await Promise.allSettled(nonZero.map((b) => call("alchemy_getTokenMetadata", [b.contractAddress])));
    nonZero.forEach((b, i) => {
      const contract = safeAddr(b.contractAddress);
      if (!contract) return;
      const m = metas[i]?.status === "fulfilled" ? (metas[i] as PromiseFulfilledResult<unknown>).value as Record<string, unknown> : {};
      res.tokens.push({
        standard: "erc20",
        contract,
        tokenId: null,
        balance: BigInt(b.tokenBalance).toString(),
        name: (m.name as string) ?? null,
        symbol: (m.symbol as string) ?? null,
        decimals: num(m.decimals),
        usdPrice: null,
        imageUrl: (m.logo as string) ?? null,
        indexerSpam: false,
      });
    });
  } catch (e) {
    res.errors.push(`ERC-20 index unavailable: ${(e as Error).message}`);
  }

  try {
    let pageKey: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ owner, withMetadata: "true", pageSize: "100", ...(pageKey ? { pageKey } : {}) });
      const r = (await getJson(`${nftBase}/getNFTsForOwner?${qs}`)) as {
        ownedNfts: {
          contract: { address: string; name?: string; symbol?: string; tokenType?: string; isSpam?: boolean };
          tokenId: string;
          balance?: string;
          image?: { cachedUrl?: string; thumbnailUrl?: string };
        }[];
        pageKey?: string;
      };
      for (const n of r.ownedNfts) {
        const contract = safeAddr(n.contract.address);
        const type = n.contract.tokenType;
        if (!contract || (type !== "ERC721" && type !== "ERC1155")) continue;
        res.tokens.push({
          standard: type === "ERC721" ? "erc721" : "erc1155",
          contract,
          tokenId: BigInt(n.tokenId).toString(),
          balance: n.balance ?? "1",
          name: n.contract.name ?? null,
          symbol: n.contract.symbol ?? null,
          decimals: 0,
          usdPrice: null,
          imageUrl: n.image?.thumbnailUrl ?? n.image?.cachedUrl ?? null,
          indexerSpam: !!n.contract.isSpam,
        });
      }
      pageKey = r.pageKey;
      if (!pageKey) break;
    }
    res.truncated ||= !!pageKey;
    res.covers.erc721 = true;
    res.covers.erc1155 = true;
  } catch (e) {
    res.errors.push(`NFT index unavailable: ${(e as Error).message}`);
  }
  return res;
}

export async function discoverWithConfiguredIndexer(chainId: number, owner: Address): Promise<IndexerResponse> {
  const provider = (process.env.ASSET_INDEXER ?? "blockscout").toLowerCase();
  if (provider === "none") return emptyResponse("none", chainId, false, ["No asset indexer configured."]);
  if (provider === "alchemy") {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) return emptyResponse("alchemy", chainId, false, ["ALCHEMY_API_KEY is not set."]);
    const r = await alchemyDiscover(chainId, owner, key);
    // Alchemy has no Chiado support; fall back so coverage is not silently lost.
    return r.supported ? r : blockscoutDiscover(chainId, owner);
  }
  return blockscoutDiscover(chainId, owner);
}

export function sanitizeIndexerTokens(tokens: IndexedToken[]): IndexedToken[] {
  return tokens.filter((t) => /^\d+$/.test(t.balance) && (t.tokenId === null || /^\d+$/.test(t.tokenId)));
}
