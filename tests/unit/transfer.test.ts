import { decodeFunctionData, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { erc1155Abi, erc20Abi, erc721Abi } from "@/lib/abis";
import type { MigrationAction } from "@/lib/domain/types";
import { buildTransferCall, pruneZeroErc1155, simulateTransfer, verifyTransfer } from "@/lib/services/asset-transfer";
import { buildActions } from "@/lib/services/migration-planning";
import { asset, NFT, SAFE, SEPOLIA, SOURCE, TOKEN } from "./fixtures";

const reads = vi.hoisted(() => ({
  erc20: new Map<string, bigint>(),
  owner: null as string | null,
  erc1155: [] as bigint[],
  erc1155Source: [] as bigint[],
}));

vi.mock("@/lib/services/onchain-verification", () => ({
  readErc20Balance: vi.fn(async (_c: unknown, _t: string, holder: string) => reads.erc20.get(holder.toLowerCase()) ?? 0n),
  readErc721Owner: vi.fn(async () => reads.owner),
  readErc1155Balances: vi.fn(async (_c: unknown, _t: string, holder: string) =>
    holder.toLowerCase() === SAFE.toLowerCase() ? reads.erc1155 : reads.erc1155Source,
  ),
  inspectSafe: vi.fn(),
  compareSafeToConfig: vi.fn(),
}));

const client = { getBalance: vi.fn(async () => 0n), call: vi.fn() } as unknown as PublicClient & { call: ReturnType<typeof vi.fn> };

const [, erc20Action, nftAction, multiAction] = buildActions(
  SEPOLIA,
  [
    asset({ standard: "erc20", balance: "1000" }),
    asset({ standard: "erc721", contract: NFT, tokenId: "5" }),
    asset({ standard: "erc1155", contract: NFT, tokenId: "1", balance: "3" }),
    asset({ standard: "erc1155", contract: NFT, tokenId: "2", balance: "4" }),
  ],
  true,
) as [MigrationAction, MigrationAction, MigrationAction, MigrationAction];

beforeEach(() => {
  reads.erc20.clear();
  reads.owner = null;
  reads.erc1155 = [];
  reads.erc1155Source = [];
});

describe("transfer call encoding", () => {
  it("sends ERC-20 directly to the Safe with no approval", () => {
    const call = buildTransferCall(erc20Action, SOURCE, SAFE);
    expect(call.to).toBe(TOKEN);
    const d = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(d.functionName).toBe("transfer");
    expect(d.args).toEqual([SAFE, 1000n]);
  });

  it("uses safeTransferFrom for NFTs and batch transfer for multiple ERC-1155 ids", () => {
    expect(decodeFunctionData({ abi: erc721Abi, data: buildTransferCall(nftAction, SOURCE, SAFE).data }).functionName).toBe("safeTransferFrom");
    const batch = decodeFunctionData({ abi: erc1155Abi, data: buildTransferCall(multiAction, SOURCE, SAFE).data });
    expect(batch.functionName).toBe("safeBatchTransferFrom");
    expect(batch.args?.[2]).toEqual([1n, 2n]);
  });

  it("prunes zero-balance ERC-1155 ids before sending", () => {
    expect(pruneZeroErc1155(multiAction, ["0", "4"])).toEqual({ tokenIds: ["2"], amounts: ["4"] });
  });
});

describe("transfer simulation", () => {
  it("accepts tokens that return nothing and rejects tokens that return false", async () => {
    const call = buildTransferCall(erc20Action, SOURCE, SAFE);
    client.call.mockResolvedValueOnce({ data: "0x" });
    expect(await simulateTransfer(client, SOURCE, erc20Action, call)).toEqual({ ok: true });
    client.call.mockResolvedValueOnce({ data: `0x${"0".repeat(64)}` });
    expect((await simulateTransfer(client, SOURCE, erc20Action, call)).ok).toBe(false);
    client.call.mockRejectedValueOnce(Object.assign(new Error("x"), { shortMessage: "execution reverted: restricted" }));
    const res = await simulateTransfer(client, SOURCE, erc20Action, call);
    expect(res).toEqual({ ok: false, reason: "Simulation reverted: execution reverted: restricted" });
  });
});

describe("post-transfer verification", () => {
  it("verifies by Safe balance delta, not by transaction submission", async () => {
    reads.erc20.set(SAFE.toLowerCase(), 1500n);
    const res = await verifyTransfer(client, { ...erc20Action, safeBalancesBefore: ["500"] }, SOURCE, SAFE, 10n);
    expect(res.status).toBe("verified");
    expect(res.verification.safeDelta).toBe("1000");
  });

  it("reports fee-on-transfer shortfalls as a discrepancy", async () => {
    reads.erc20.set(SAFE.toLowerCase(), 990n);
    const res = await verifyTransfer(client, { ...erc20Action, safeBalancesBefore: ["0"] }, SOURCE, SAFE, 10n);
    expect(res.status).toBe("verified_with_discrepancy");
    expect(res.verification.note).toMatch(/fee-on-transfer/);
  });

  it("needs attention when nothing arrived", async () => {
    reads.erc20.set(SAFE.toLowerCase(), 0n);
    const res = await verifyTransfer(client, { ...erc20Action, safeBalancesBefore: ["0"] }, SOURCE, SAFE, 10n);
    expect(res.status).toBe("needs_attention");
  });

  it("checks NFT ownership directly", async () => {
    reads.owner = SAFE;
    expect((await verifyTransfer(client, nftAction, SOURCE, SAFE, 10n)).status).toBe("verified");
    reads.owner = SOURCE;
    expect((await verifyTransfer(client, nftAction, SOURCE, SAFE, 10n)).status).toBe("needs_attention");
  });

  it("requires every ERC-1155 id to arrive in full", async () => {
    reads.erc1155 = [3n, 4n];
    expect((await verifyTransfer(client, { ...multiAction, safeBalancesBefore: ["0", "0"] }, SOURCE, SAFE, 10n)).status).toBe("verified");
    reads.erc1155 = [3n, 0n];
    expect((await verifyTransfer(client, { ...multiAction, safeBalancesBefore: ["0", "0"] }, SOURCE, SAFE, 10n)).status).toBe("verified_with_discrepancy");
  });
});
