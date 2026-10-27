import { describe, expect, it } from "vitest";
import { emptyWatchState } from "@/lib/domain/profile";
import type { DiscoveredAsset, NetworkDiscovery } from "@/lib/domain/types";
import { applyScan, ignoreArrival, meaningfulIncrease, withHandledFromMigration } from "@/lib/services/late-arrivals";
import { asset, CHIADO, NFT, sampleMigration, SEPOLIA, TOKEN } from "./fixtures";

function discovery(chainId: number, assets: DiscoveredAsset[], status: NetworkDiscovery["status"] = "ok"): NetworkDiscovery {
  return {
    chainId,
    status,
    nativeBalance: null,
    assets,
    errors: status === "ok" ? [] : ["Indexer failed"],
    indexer: null,
    coverage: { native: true, erc20: "indexed", erc721: "indexed", erc1155: "indexed", truncated: false },
    droppedZeroBalance: 0,
    scannedAt: 1,
  };
}

const usd = asset({ standard: "erc20", contract: TOKEN, symbol: "mUSD", balance: "5000000" });
const nft = asset({ standard: "erc721", contract: NFT, tokenId: "7", name: "Art", balance: "1" });
const native = (balance: string) => asset({ standard: "native", balance, decimals: 18, symbol: "ETH" });

describe("late arrivals", () => {
  it("reports a new ERC-20 and NFT after a completed run, but not what the run handled", () => {
    const run = sampleMigration();
    const watch = withHandledFromMigration(emptyWatchState(), run, 10);
    const handledNative = watch.handled.find((h) => h.assetId === `${SEPOLIA}:native:native`);
    expect(handledNative).toMatchObject({ reason: "migrated", balance: "1000" });
    const feeId = `${SEPOLIA}:erc20:${TOKEN.toLowerCase()}`;
    expect(watch.handled.find((h) => h.assetId === feeId)?.reason).toBe("migrated");

    const scan = applyScan(watch, { [SEPOLIA]: discovery(SEPOLIA, [native("1500"), nft, asset({ ...usd, contract: TOKEN, id: `${SEPOLIA}:erc20:0xnew` })]) }, 20);
    expect(scan.watch.pending.map((p) => [p.assetId, p.kind])).toEqual([
      [`${SEPOLIA}:erc20:0xnew`, "new"],
      [nft.id, "new"],
    ]);
    expect(scan.newCount).toBe(2);
  });

  it("resurfaces a handled asset only when its balance grows meaningfully", () => {
    expect(meaningfulIncrease("1000000", "1040000", usd)).toBe(false);
    expect(meaningfulIncrease("1000000", "1060000", usd)).toBe(true);
    expect(meaningfulIncrease("0", "1", nft)).toBe(true);
    expect(meaningfulIncrease("1000", "1000000000000", native("0"))).toBe(false);
    expect(meaningfulIncrease("1000", "2000000000000000", native("0"))).toBe(true);
    const watch = withHandledFromMigration(emptyWatchState(), sampleMigration(), 10);
    const feeId = `${SEPOLIA}:erc20:${TOKEN.toLowerCase()}`;
    const again = applyScan(watch, { [SEPOLIA]: discovery(SEPOLIA, [asset({ standard: "erc20", contract: TOKEN, balance: "250", id: feeId })]) }, 20);
    expect(again.watch.pending).toEqual([expect.objectContaining({ assetId: feeId, kind: "increased", previousBalance: "0" })]);
  });

  it("does not clear unresolved arrivals when a scan fails or is partial", () => {
    const first = applyScan(emptyWatchState(), { [CHIADO]: discovery(CHIADO, [asset({ ...usd, chainId: CHIADO, id: `${CHIADO}:erc20:x` })]) }, 1).watch;
    expect(first.pending).toHaveLength(1);
    const failed = applyScan(first, { [CHIADO]: discovery(CHIADO, [], "error") }, 2).watch;
    expect(failed.pending).toHaveLength(1);
    expect(failed.checks[0]).toMatchObject({ status: "error" });
    const partial = applyScan(failed, { [CHIADO]: discovery(CHIADO, [], "partial") }, 3).watch;
    expect(partial.pending).toHaveLength(1);
    const gone = applyScan(partial, { [CHIADO]: discovery(CHIADO, []) }, 4).watch;
    expect(gone.pending).toHaveLength(0);
  });

  it("keeps ignored items ignored and never surfaces suspicious tokens", () => {
    const spam = asset({ standard: "erc20", contract: TOKEN, id: `${SEPOLIA}:erc20:spam`, classification: "suspicious", symbol: "Claim $5000" });
    const first = applyScan(emptyWatchState(), { [SEPOLIA]: discovery(SEPOLIA, [nft, spam]) }, 1);
    expect(first.hiddenSuspicious).toBe(1);
    expect(first.watch.pending.map((p) => p.assetId)).toEqual([nft.id]);
    const ignored = ignoreArrival(first.watch, first.watch.pending[0]!, 2);
    const later = applyScan(ignored, { [SEPOLIA]: discovery(SEPOLIA, [nft, spam]) }, 3);
    expect(later.watch.pending).toEqual([]);
  });

  it("baselines retained gas dust and excluded assets from the run's scope", () => {
    const m = sampleMigration();
    m.chains[0]!.actions[2] = { ...m.chains[0]!.actions[2]!, status: "skipped", verification: { expected: "0", safeDelta: null, sourceRemaining: null, note: "Skipped: dust", blockNumber: null }, assetIds: [`${SEPOLIA}:native:native`] };
    m.scope!.selectedAssets = [{ assetId: `${SEPOLIA}:native:native`, chainId: SEPOLIA, label: "ETH", amount: "400000000000000", decimals: 18, reason: null }];
    const watch = withHandledFromMigration(emptyWatchState(), m, 1);
    expect(watch.handled.find((h) => h.assetId === `${SEPOLIA}:native:native`)).toMatchObject({ reason: "retained", balance: "400000000000000" });
    expect(watch.handled.find((h) => h.reason === "excluded")).toBeTruthy();
    const scan = applyScan(watch, { [SEPOLIA]: discovery(SEPOLIA, [native("400000000000000")]) }, 2);
    expect(scan.watch.pending).toEqual([]);
  });
});
