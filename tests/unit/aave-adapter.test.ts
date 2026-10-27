/**
 * Aave v3 adapter logic with a MOCKED chain (contract reads answered in memory). This checks the
 * adapter's decisions; it is NOT evidence that it works against deployed Aave contracts. The beta
 * stays disabled until the fork suite (tests/integration/aave-fork.test.ts) has passed.
 */
import { getAddress, type Address, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationAction } from "@/lib/domain/types";
import { AAVE_V3_MARKETS, aaveV3Adapter } from "@/lib/services/protocols/aave-v3";
import { asset, SAFE, SEPOLIA, SOURCE } from "./fixtures";

vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/config")>();
  return { ...actual, appConfig: { ...actual.appConfig, enableAaveV3Beta: true } };
});

const market = AAVE_V3_MARKETS.find((m) => m.chainId === SEPOLIA)!;
const USDC = getAddress("0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8");
const A_USDC = getAddress("0x16dA4541aD1807f4443d92D26044C1147406EB80");
const FAKE_A = getAddress("0x00000000000000000000000000000000000000fa");

const chain = vi.hoisted(() => ({ debt: 0n, debtFails: false, providerPool: "", aTokenPool: "", fail: false }));

function client(): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (chain.fail) throw new Error("rpc down");
      switch (functionName) {
        case "getPool":
          return chain.providerPool || market.pool;
        case "getPoolDataProvider":
          return market.dataProvider;
        case "getReservesList":
          return [USDC];
        case "getReserveTokensAddresses":
          return [A_USDC, getAddress("0x00000000000000000000000000000000000000d1"), getAddress("0x00000000000000000000000000000000000000d2")];
        case "getUserAccountData":
          if (chain.debtFails) throw new Error("execution reverted");
          return [100n, chain.debt, 0n, 0n, 0n, 0n];
        case "UNDERLYING_ASSET_ADDRESS":
          return USDC;
        case "POOL":
          return address === A_USDC ? chain.aTokenPool || market.pool : market.pool;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const aUsdc = () => asset({ standard: "erc20", contract: A_USDC, symbol: "aEthUSDC", name: "Aave Ethereum USDC", classification: "specialized", flags: ["protocol_position"], reasons: ["Aave aToken"] });
const spoof = () => asset({ standard: "erc20", contract: FAKE_A, symbol: "aEthUSDC", name: "Aave Ethereum USDC", classification: "specialized", flags: ["protocol_position"], id: `${SEPOLIA}:erc20:${FAKE_A.toLowerCase()}` });

beforeEach(() => Object.assign(chain, { debt: 0n, debtFails: false, providerPool: "", aTokenPool: "", fail: false }));

describe("Aave v3 adapter (mocked reads)", () => {
  it("makes a registry-verified aToken transferable when the source has no debt", async () => {
    const [a] = await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() });
    expect(a).toMatchObject({ classification: "transferable", protocol: { adapter: "aave-v3", pool: market.pool, underlying: USDC } });
    expect(a!.reasons.join(" ")).toMatch(/rewards accrued so far stay claimable/);
  });

  it("never trusts names or symbols: a look-alike token stays specialized", async () => {
    const [a] = await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [spoof()], client: client() });
    expect(a!.classification).toBe("specialized");
    expect(a!.protocol).toBeUndefined();
  });

  it("refuses when debt exists or cannot be read", async () => {
    chain.debt = 5n;
    expect((await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() }))[0]).toMatchObject({ classification: "specialized" });
    chain.debt = 0n;
    chain.debtFails = true;
    const [a] = await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() });
    expect(a!.classification).toBe("specialized");
    expect(a!.reasons.join(" ")).toMatch(/could not be read/);
  });

  it("refuses when the market or the token does not verify against the registry", async () => {
    chain.providerPool = getAddress("0x00000000000000000000000000000000000000bb");
    expect((await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() }))[0]!.classification).toBe("specialized");
    chain.providerPool = "";
    chain.aTokenPool = getAddress("0x00000000000000000000000000000000000000cc");
    expect((await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() }))[0]!.classification).toBe("specialized");
    chain.aTokenPool = "";
    chain.fail = true;
    expect((await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: SOURCE, assets: [aUsdc()], client: client() }))[0]!.classification).toBe("specialized");
  });

  it("rechecks debt immediately before sending", async () => {
    const action = { protocol: { adapter: "aave-v3", market: market.name, pool: market.pool, underlying: USDC } } as MigrationAction;
    expect(await aaveV3Adapter.recheck({ chainId: SEPOLIA, source: SOURCE, action, client: client() })).toEqual({ ok: true });
    chain.debt = 1n;
    expect((await aaveV3Adapter.recheck({ chainId: SEPOLIA, source: SOURCE, action, client: client() })).ok).toBe(false);
    chain.debt = 0n;
    const forged = { protocol: { ...action.protocol!, pool: SAFE } } as MigrationAction;
    expect((await aaveV3Adapter.recheck({ chainId: SEPOLIA, source: SOURCE, action: forged, client: client() })).ok).toBe(false);
  });

  it("tolerates only rounding and accrual, never a real shortfall", () => {
    const action = { safeBalancesBefore: ["1000000000"] } as MigrationAction;
    const outcome = (delta: string) => ({ status: "verified_with_discrepancy" as const, verification: { expected: "5000000", safeDelta: delta, sourceRemaining: "3", note: null, blockNumber: "1" } });
    expect(aaveV3Adapter.interpretVerification(action, outcome("4999999")).status).toBe("verified");
    expect(aaveV3Adapter.interpretVerification(action, outcome("5050000")).status).toBe("verified");
    expect(aaveV3Adapter.interpretVerification(action, outcome("4990000")).status).toBe("verified_with_discrepancy");
    expect(aaveV3Adapter.interpretVerification(action, outcome("6000000")).status).toBe("verified_with_discrepancy");
  });
});
