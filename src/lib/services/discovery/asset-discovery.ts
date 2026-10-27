import { getAddress, type Address, type PublicClient } from "viem";
import { erc1155Abi, erc20Abi, erc721Abi } from "@/lib/abis";
import { getChain } from "@/lib/chains/registry";
import { approximateUsd } from "@/lib/domain/amounts";
import type {
  AssetSource,
  AssetStandard,
  CoverageLevel,
  NetworkDiscovery,
} from "@/lib/domain/types";
import { classifyAsset } from "./classification";
import type { IndexedToken, IndexerResponse } from "./indexer-types";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export interface ManualImport {
  chainId: number;
  standard: Exclude<AssetStandard, "native">;
  contract: Address;
  tokenId: string | null;
}

export function assetId(chainId: number, standard: AssetStandard, contract: string | null, tokenId: string | null): string {
  const c = contract ? contract.toLowerCase() : "native";
  return tokenId !== null ? `${chainId}:${standard}:${c}:${tokenId}` : `${chainId}:${standard}:${c}`;
}

interface Candidate {
  standard: Exclude<AssetStandard, "native">;
  contract: Address;
  tokenId: string | null;
  name: string | null;
  symbol: string | null;
  usdPrice: number | null;
  imageUrl: string | null;
  indexerSpam: boolean;
  sources: Set<AssetSource>;
}

export type IndexerFetcher = (chainId: number, owner: Address) => Promise<IndexerResponse>;

export const fetchIndexerViaApi: IndexerFetcher = async (chainId, owner) => {
  const res = await fetch(`/api/discovery?chainId=${chainId}&owner=${owner}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Indexer HTTP ${res.status}`);
  }
  return (await res.json()) as IndexerResponse;
};

function mergeCandidates(chainId: number, indexed: IndexedToken[], manual: ManualImport[]): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  const add = (c: Omit<Candidate, "sources">, source: AssetSource) => {
    const id = assetId(chainId, c.standard, c.contract, c.tokenId);
    const existing = map.get(id);
    if (existing) {
      existing.sources.add(source);
      existing.indexerSpam ||= c.indexerSpam;
      existing.usdPrice ??= c.usdPrice;
      existing.imageUrl ??= c.imageUrl;
      return;
    }
    map.set(id, { ...c, sources: new Set([source]) });
  };
  for (const k of getChain(chainId).knownTokens) {
    add(
      { standard: "erc20", contract: k.address, tokenId: null, name: k.name, symbol: k.symbol, usdPrice: null, imageUrl: null, indexerSpam: false },
      "known_list",
    );
  }
  for (const t of indexed) {
    add(
      {
        standard: t.standard,
        contract: getAddress(t.contract),
        tokenId: t.tokenId,
        name: t.name,
        symbol: t.symbol,
        usdPrice: t.usdPrice,
        imageUrl: t.imageUrl,
        indexerSpam: t.indexerSpam,
      },
      "indexer",
    );
  }
  for (const m of manual.filter((m) => m.chainId === chainId)) {
    add(
      { standard: m.standard, contract: getAddress(m.contract), tokenId: m.tokenId, name: null, symbol: null, usdPrice: null, imageUrl: null, indexerSpam: false },
      "manual",
    );
  }
  return map;
}

type MC = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** Fallback when Multicall3 is unavailable or the RPC rejects large eth_call payloads. */
async function individualReads(
  client: PublicClient,
  calls: Parameters<PublicClient["multicall"]>[0]["contracts"],
  blockNumber: bigint,
): Promise<MC[]> {
  return Promise.all(
    calls.map(async (c) => {
      try {
        return { status: "success" as const, result: await client.readContract({ ...(c as object), blockNumber } as never) };
      } catch (error) {
        return { status: "failure" as const, error: error as Error };
      }
    }),
  );
}

/**
 * Discovers assets on one network. Indexer output is only a *candidate list*: every balance,
 * owner and decimals value shown to the user is read onchain at a single block.
 */
export async function discoverNetwork(params: {
  chainId: number;
  owner: Address;
  client: PublicClient;
  manualImports?: ManualImport[];
  fetchIndexer?: IndexerFetcher;
}): Promise<NetworkDiscovery> {
  const { chainId, owner, client } = params;
  const chain = getChain(chainId);
  const errors: string[] = [];
  const result: NetworkDiscovery = {
    chainId,
    status: "ok",
    nativeBalance: null,
    assets: [],
    errors,
    indexer: null,
    coverage: { native: false, erc20: "unavailable", erc721: "unavailable", erc1155: "unavailable", truncated: false },
    droppedZeroBalance: 0,
    scannedAt: Date.now(),
  };

  let block: bigint;
  try {
    const rpcChain = await client.getChainId();
    if (rpcChain !== chainId) throw new Error(`RPC returned chain ${rpcChain}`);
    block = await client.getBlockNumber({ cacheTime: 0 });
  } catch (e) {
    result.status = "error";
    errors.push(`RPC unavailable for ${chain.name}: ${(e as Error).message.slice(0, 160)}. Balances are unknown — not zero.`);
    return result;
  }

  let indexer: IndexerResponse | null = null;
  if (params.fetchIndexer) {
    try {
      indexer = await params.fetchIndexer(chainId, owner);
      result.indexer = indexer.provider;
      errors.push(...indexer.errors);
      result.coverage.truncated = indexer.truncated;
      if (indexer.truncated) errors.push("Indexer returned more results than were scanned; some assets may be missing.");
    } catch (e) {
      errors.push(`Asset indexer failed: ${(e as Error).message.slice(0, 160)}. Showing known tokens and manual imports only.`);
    }
  }
  const manual = params.manualImports ?? [];
  const level = (covered: boolean | undefined, hasKnown: boolean): CoverageLevel =>
    covered ? "indexed" : hasKnown ? "known_list_only" : "manual_only";
  result.coverage.erc20 = level(indexer?.covers.erc20, chain.knownTokens.length > 0);
  result.coverage.erc721 = level(indexer?.covers.erc721, false);
  result.coverage.erc1155 = level(indexer?.covers.erc1155, false);

  // Native balance
  try {
    const bal = await client.getBalance({ address: owner, blockNumber: block });
    result.nativeBalance = bal.toString();
    result.coverage.native = true;
    if (bal > 0n) {
      result.assets.push({
        id: assetId(chainId, "native", null, null),
        chainId,
        standard: "native",
        contract: null,
        tokenId: null,
        name: chain.viemChain.nativeCurrency.name,
        symbol: chain.nativeSymbol,
        decimals: chain.nativeDecimals,
        balance: bal.toString(),
        usdValue: approximateUsd(bal, chain.nativeDecimals, indexer?.nativeUsdPrice ?? null),
        imageUrl: null,
        classification: "transferable",
        flags: [],
        reasons: [],
        sources: ["rpc"],
        verifiedOnchain: true,
      });
    }
  } catch (e) {
    errors.push(`Native balance read failed: ${(e as Error).message.slice(0, 120)}`);
  }

  const candidates = [...mergeCandidates(chainId, indexer?.tokens ?? [], manual).values()];

  // ERC-20: balanceOf + decimals + symbol + name
  const erc20s = candidates.filter((c) => c.standard === "erc20");
  const erc20Calls = erc20s.flatMap((c) => [
    { address: c.contract, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
    { address: c.contract, abi: erc20Abi, functionName: "decimals" },
    { address: c.contract, abi: erc20Abi, functionName: "symbol" },
    { address: c.contract, abi: erc20Abi, functionName: "name" },
  ]);
  const erc20Res = await multicallAt(client, erc20Calls, block);
  erc20s.forEach((c, i) => {
    const [bal, dec, sym, nm] = erc20Res.slice(i * 4, i * 4 + 4);
    if (bal?.status !== "success") {
      if (c.sources.has("manual") || c.sources.has("indexer")) {
        errors.push(`Could not verify balance of ${c.symbol ?? c.contract} (${c.contract}).`);
      }
      return;
    }
    const balance = bal.result as bigint;
    if (balance === 0n) {
      if (!c.sources.has("known_list") || c.sources.size > 1) result.droppedZeroBalance++;
      return;
    }
    const decimals = dec?.status === "success" ? Number(dec.result) : null;
    const symbol = sym?.status === "success" ? String(sym.result) : (c.symbol ?? "???");
    const name = nm?.status === "success" ? String(nm.result) : (c.name ?? "Unknown token");
    const cls = classifyAsset({
      chainId,
      standard: "erc20",
      contract: c.contract,
      name,
      symbol,
      indexerSpam: c.indexerSpam,
      metadataVerified: decimals !== null && decimals <= 77,
    });
    result.assets.push({
      id: assetId(chainId, "erc20", c.contract, null),
      chainId,
      standard: "erc20",
      contract: c.contract,
      tokenId: null,
      name,
      symbol,
      decimals: decimals ?? 0,
      balance: balance.toString(),
      usdValue: decimals !== null && cls.classification === "transferable" ? approximateUsd(balance, decimals, c.usdPrice) : null,
      imageUrl: c.imageUrl,
      ...cls,
      sources: [...c.sources, "rpc"],
      verifiedOnchain: true,
    });
  });

  // ERC-721: ownerOf
  const erc721s = candidates.filter((c) => c.standard === "erc721" && c.tokenId !== null);
  const erc721Res = await multicallAt(
    client,
    erc721s.flatMap((c) => [
      { address: c.contract, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(c.tokenId!)] },
      { address: c.contract, abi: erc721Abi, functionName: "name" },
      { address: c.contract, abi: erc721Abi, functionName: "symbol" },
    ]),
    block,
  );
  erc721s.forEach((c, i) => {
    const [own, nm, sym] = erc721Res.slice(i * 3, i * 3 + 3);
    if (own?.status !== "success") {
      errors.push(`Could not verify ownership of ${c.name ?? c.contract} #${c.tokenId}.`);
      return;
    }
    if ((own.result as string).toLowerCase() !== owner.toLowerCase()) {
      result.droppedZeroBalance++;
      return;
    }
    const name = nm?.status === "success" ? String(nm.result) : (c.name ?? "Unknown collection");
    const symbol = sym?.status === "success" ? String(sym.result) : (c.symbol ?? "NFT");
    const cls = classifyAsset({ chainId, standard: "erc721", contract: c.contract, name, symbol, indexerSpam: c.indexerSpam, metadataVerified: true });
    result.assets.push({
      id: assetId(chainId, "erc721", c.contract, c.tokenId),
      chainId,
      standard: "erc721",
      contract: c.contract,
      tokenId: c.tokenId,
      name,
      symbol,
      decimals: 0,
      balance: "1",
      usdValue: null,
      imageUrl: c.imageUrl,
      ...cls,
      sources: [...c.sources, "rpc"],
      verifiedOnchain: true,
    });
  });

  // ERC-1155: balanceOf(owner, id)
  const erc1155s = candidates.filter((c) => c.standard === "erc1155" && c.tokenId !== null);
  const erc1155Res = await multicallAt(
    client,
    erc1155s.map((c) => ({ address: c.contract, abi: erc1155Abi, functionName: "balanceOf", args: [owner, BigInt(c.tokenId!)] })),
    block,
  );
  erc1155s.forEach((c, i) => {
    const r = erc1155Res[i];
    if (r?.status !== "success") {
      errors.push(`Could not verify ERC-1155 balance of ${c.name ?? c.contract} #${c.tokenId}.`);
      return;
    }
    const balance = r.result as bigint;
    if (balance === 0n) {
      result.droppedZeroBalance++;
      return;
    }
    const name = c.name ?? "ERC-1155 collection";
    const symbol = c.symbol ?? "1155";
    const cls = classifyAsset({ chainId, standard: "erc1155", contract: c.contract, name, symbol, indexerSpam: c.indexerSpam, metadataVerified: true });
    result.assets.push({
      id: assetId(chainId, "erc1155", c.contract, c.tokenId),
      chainId,
      standard: "erc1155",
      contract: c.contract,
      tokenId: c.tokenId,
      name,
      symbol,
      decimals: 0,
      balance: balance.toString(),
      usdValue: null,
      imageUrl: c.imageUrl,
      ...cls,
      sources: [...c.sources, "rpc"],
      verifiedOnchain: true,
    });
  });

  if (errors.length > 0) result.status = "partial";
  return result;
}

async function multicallAt(client: PublicClient, calls: unknown[], blockNumber: bigint): Promise<MC[]> {
  const CHUNK = 120;
  const out: MC[] = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK) as Parameters<PublicClient["multicall"]>[0]["contracts"];
    try {
      out.push(
        ...((await client.multicall({ contracts: chunk, allowFailure: true, multicallAddress: MULTICALL3, blockNumber })) as MC[]),
      );
    } catch {
      out.push(...(await individualReads(client, chunk, blockNumber)));
    }
  }
  return out;
}

export function coverageStatement(networks: NetworkDiscovery[]): string {
  const names = networks.map((n) => getChain(n.chainId).name);
  return `Scanned ${names.join(", ")}. Native balances are read directly from each network. Tokens and NFTs come from the configured indexer plus known-token lists and your manual imports, and every balance is re-verified onchain. Positions inside protocols (lending, staking, LPs, vesting) and assets on other networks are not discovered.`;
}
