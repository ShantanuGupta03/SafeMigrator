import type { Address } from "viem";

/** Normalized output of any asset indexer. Every entry is re-verified onchain by the client. */
export interface IndexedToken {
  standard: "erc20" | "erc721" | "erc1155";
  contract: Address;
  tokenId: string | null;
  balance: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  usdPrice: number | null;
  imageUrl: string | null;
  indexerSpam: boolean;
}

export interface IndexerResponse {
  provider: string;
  chainId: number;
  supported: boolean;
  tokens: IndexedToken[];
  nativeUsdPrice: number | null;
  truncated: boolean;
  errors: string[];
  /** Which standards this provider indexes on this chain. */
  covers: { erc20: boolean; erc721: boolean; erc1155: boolean };
}
