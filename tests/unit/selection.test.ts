import { describe, expect, it } from "vitest";
import { effectiveSelection, withoutChain } from "@/lib/services/selection";
import { asset, CHIADO, SEPOLIA } from "./fixtures";

describe("effectiveSelection", () => {
  const env = [SEPOLIA, CHIADO];
  const aSep = asset({ chainId: SEPOLIA, id: `${SEPOLIA}:native`, standard: "native" });
  const aChi = asset({ chainId: CHIADO, id: `${CHIADO}:erc20:0x1`, standard: "erc20", contract: "0x0000000000000000000000000000000000000001" });

  it("drops assets on deselected networks", () => {
    const sel = effectiveSelection({
      envChainIds: env,
      selectedChains: [SEPOLIA],
      selectedAssetIds: [aSep.id, aChi.id],
      acknowledgedSuspicious: [],
      discovery: {
        [SEPOLIA]: {
          chainId: SEPOLIA,
          status: "ok",
          nativeBalance: "1",
          assets: [aSep],
          errors: [],
          indexer: "test",
          coverage: { native: true, erc20: "indexed", erc721: "indexed", erc1155: "indexed", truncated: false },
          droppedZeroBalance: 0,
          scannedAt: 1,
        },
        [CHIADO]: {
          chainId: CHIADO,
          status: "ok",
          nativeBalance: "1",
          assets: [aChi],
          errors: [],
          indexer: "test",
          coverage: { native: true, erc20: "indexed", erc721: "indexed", erc1155: "indexed", truncated: false },
          droppedZeroBalance: 0,
          scannedAt: 1,
        },
      },
    });
    expect(sel.chainIds).toEqual([SEPOLIA]);
    expect(sel.assetIds).toEqual([aSep.id]);
    expect(sel.dropped.some((d) => d.assetId === aChi.id && d.reason === "network_not_selected")).toBe(true);
  });

  it("withoutChain removes stale ids when a network is toggled off", () => {
    expect(withoutChain([aSep.id, aChi.id], CHIADO)).toEqual([aSep.id]);
  });
});
