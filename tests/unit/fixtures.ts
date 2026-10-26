import { getAddress, type Address } from "viem";
import type { DiscoveredAsset, SafeContractSet, SignerSlot } from "@/lib/domain/types";
import { canonicalContracts } from "@/lib/services/safe-deployment";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";

export const SEPOLIA = 11155111;
export const CHIADO = 10200;

export const SOURCE = getAddress("0x00000000000000000000000000000000000000a1");
export const OWNER_B = getAddress("0x00000000000000000000000000000000000000b2");
export const OWNER_C = getAddress("0x00000000000000000000000000000000000000c3");
export const SAFE = getAddress("0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe");
export const TOKEN = getAddress("0x7070707070707070707070707070707070707070");
export const NFT = getAddress("0x8080808080808080808080808080808080808080");

export const CONFIG = buildSafeConfig([OWNER_C, SOURCE, OWNER_B], 2, deriveSaltNonce(SOURCE));

export function contracts130(): SafeContractSet {
  const c = canonicalContracts("1.3.0");
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.address])) as unknown as SafeContractSet;
}

export function asset(partial: Partial<DiscoveredAsset> & Pick<DiscoveredAsset, "standard">): DiscoveredAsset {
  const chainId = partial.chainId ?? SEPOLIA;
  const contract = partial.contract ?? (partial.standard === "native" ? null : TOKEN);
  return {
    id: `${chainId}:${partial.standard}:${contract?.toLowerCase() ?? "native"}${partial.tokenId ? `:${partial.tokenId}` : ""}`,
    chainId,
    contract,
    tokenId: null,
    name: "Token",
    symbol: "TKN",
    decimals: partial.standard === "native" ? 18 : 6,
    balance: "1000000",
    usdValue: null,
    imageUrl: null,
    classification: "transferable",
    flags: [],
    reasons: [],
    sources: ["rpc"],
    verifiedOnchain: true,
    ...partial,
  };
}

export function slot(i: number, address: Address | null, input = address ?? ""): SignerSlot {
  return { slot: i, input, address, ensName: null, kind: "independent_wallet", label: `Signer ${i + 1}`, verification: null };
}
