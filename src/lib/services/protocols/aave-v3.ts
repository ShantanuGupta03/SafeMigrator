import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { appConfig } from "@/lib/config";
import type { DiscoveredAsset, MigrationAction } from "@/lib/domain/types";
import type { VerifyOutcome } from "../asset-transfer";
import type { DebtStatus, ProtocolAdapter, ProtocolContext } from "./types";

/*
 * Aave v3 supply positions (aTokens), beta. Scope: standard aTokens of the core markets listed in
 * AAVE_V3_MARKETS, for a source with NO debt in that market's pool. Moving an aToken moves the
 * supply claim: interest keeps accruing to the holder (the Safe). Incentive rewards already accrued
 * stay claimable by the source address; they are not claimed or moved.
 *
 * Identity is never taken from names or symbols: the market is re-derived from its
 * PoolAddressesProvider, every aToken from the pool's reserve list via the PoolDataProvider, and each
 * candidate aToken must point back to the same pool and underlying. Debt is read for the whole pool
 * (getUserAccountData.totalDebtBase); any read failure counts as unknown and blocks.
 *
 * Addresses: bgd-labs/aave-address-book (main), src/AaveV3{Sepolia,BaseSepolia,Ethereum,Base}.sol,
 * checked while implementing v1.5. Re-verify before enabling the beta anywhere.
 */

export interface AaveMarket {
  chainId: number;
  name: string;
  addressesProvider: Address;
  pool: Address;
  dataProvider: Address;
}

export const AAVE_V3_MARKETS: readonly AaveMarket[] = [
  { chainId: 11155111, name: "Aave v3 Sepolia", addressesProvider: getAddress("0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"), pool: getAddress("0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951"), dataProvider: getAddress("0x3e9708d80f7B3e43118013075F7e95CE3AB31F31") },
  { chainId: 84532, name: "Aave v3 Base Sepolia", addressesProvider: getAddress("0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00"), pool: getAddress("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"), dataProvider: getAddress("0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b") },
  { chainId: 1, name: "Aave v3 Ethereum Core", addressesProvider: getAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"), pool: getAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"), dataProvider: getAddress("0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD") },
  { chainId: 8453, name: "Aave v3 Base", addressesProvider: getAddress("0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D"), pool: getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"), dataProvider: getAddress("0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A") },
];

export const addressesProviderAbi = parseAbi(["function getPool() view returns (address)", "function getPoolDataProvider() view returns (address)"]);
export const poolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
export const dataProviderAbi = parseAbi(["function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)"]);
export const aTokenAbi = parseAbi(["function UNDERLYING_ASSET_ADDRESS() view returns (address)", "function POOL() view returns (address)"]);

/** Base units an aToken balance may differ by from the amount sent (ray-division rounding). */
export const AAVE_ROUNDING_TOLERANCE = 2n;

export function marketFor(chainId: number): AaveMarket | undefined {
  return AAVE_V3_MARKETS.find((m) => m.chainId === chainId);
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** aToken → underlying for a market, derived from protocol reads. Null when the market cannot be verified. */
export async function readMarketATokens(client: PublicClient, market: AaveMarket): Promise<Map<string, Address> | null> {
  try {
    const [pool, dataProvider] = await Promise.all([
      client.readContract({ address: market.addressesProvider, abi: addressesProviderAbi, functionName: "getPool" }),
      client.readContract({ address: market.addressesProvider, abi: addressesProviderAbi, functionName: "getPoolDataProvider" }),
    ]);
    if (!eq(pool, market.pool) || !eq(dataProvider, market.dataProvider)) return null;
    const reserves = await client.readContract({ address: market.pool, abi: poolAbi, functionName: "getReservesList" });
    const out = new Map<string, Address>();
    for (const reserve of reserves) {
      const [aToken] = await client.readContract({ address: market.dataProvider, abi: dataProviderAbi, functionName: "getReserveTokensAddresses", args: [reserve] });
      out.set(aToken.toLowerCase(), getAddress(reserve));
    }
    return out;
  } catch {
    return null;
  }
}

/** The source's debt in this market's pool, across every reserve. Failures are `unknown`, never "none". */
export async function readDebt(client: PublicClient, market: AaveMarket, user: Address): Promise<DebtStatus> {
  try {
    const data = await client.readContract({ address: market.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user], blockTag: "latest" });
    const totalDebtBase = data[1];
    return totalDebtBase === 0n ? { state: "none" } : { state: "present", detail: `outstanding debt worth ${totalDebtBase} base-currency units` };
  } catch (e) {
    return { state: "unknown", detail: (e as Error).message.slice(0, 120) };
  }
}

async function confirmsATokenOf(client: PublicClient, aToken: Address, market: AaveMarket, underlying: Address): Promise<boolean> {
  try {
    const [u, pool] = await Promise.all([
      client.readContract({ address: aToken, abi: aTokenAbi, functionName: "UNDERLYING_ASSET_ADDRESS" }),
      client.readContract({ address: aToken, abi: aTokenAbi, functionName: "POOL" }),
    ]);
    return eq(u, underlying) && eq(pool, market.pool);
  } catch {
    return false;
  }
}

export const aaveV3Adapter: ProtocolAdapter = {
  id: "aave-v3",
  enabled: () => appConfig.enableAaveV3Beta,

  async enrich({ chainId, source, assets, client }) {
    const market = marketFor(chainId);
    const candidates = assets.filter((a) => a.chainId === chainId && a.standard === "erc20" && a.contract && BigInt(a.balance) > 0n && a.classification !== "suspicious");
    if (!market || candidates.length === 0) return [...assets];
    const aTokens = await readMarketATokens(client, market);
    if (!aTokens) {
      return assets.map((a) =>
        candidates.includes(a) && a.flags.includes("protocol_position")
          ? { ...a, reasons: [...a.reasons, `${market.name} could not be verified onchain, so this position stays unsupported.`] }
          : a,
      );
    }
    const matched = candidates.filter((a) => aTokens.has(a.contract!.toLowerCase()));
    if (matched.length === 0) return [...assets];
    const debt = await readDebt(client, market, source);
    const out: DiscoveredAsset[] = [];
    for (const a of assets) {
      if (!matched.includes(a)) {
        out.push(a);
        continue;
      }
      const underlying = aTokens.get(a.contract!.toLowerCase())!;
      const confirmed = await confirmsATokenOf(client, a.contract!, market, underlying);
      const protocol: ProtocolContext = { adapter: "aave-v3", market: market.name, pool: market.pool, underlying };
      const flags = [...new Set([...a.flags, "protocol_position" as const])];
      if (!confirmed) {
        out.push({ ...a, classification: "specialized", flags, reasons: [`Listed by ${market.name} but the token does not confirm its pool and underlying. Not moved.`] });
      } else if (debt.state === "none") {
        out.push({
          ...a,
          classification: "transferable",
          flags,
          protocol,
          reasons: [
            `${market.name} supply position (beta). Moving it moves the supply claim on ${underlying}; interest keeps accruing to the Safe. Incentive rewards accrued so far stay claimable by this wallet.`,
            "No debt was found in this market; this is checked again right before sending.",
          ],
        });
      } else {
        out.push({
          ...a,
          classification: "specialized",
          flags,
          reasons: [
            debt.state === "present"
              ? `This wallet has ${debt.detail} in ${market.name}. Moving supplied collateral could make the debt liquidatable, so it is not moved.`
              : `Debt in ${market.name} could not be read (${debt.detail}). Unknown debt blocks this position.`,
          ],
        });
      }
    }
    return out;
  },

  async recheck({ chainId, source, action, client }) {
    const market = marketFor(chainId);
    if (!market || !action.protocol || !eq(action.protocol.pool, market.pool)) return { ok: false, reason: "Aave market for this action is not in the verified registry." };
    if (!appConfig.enableAaveV3Beta) return { ok: false, reason: "The Aave v3 beta is disabled in this build." };
    const debt = await readDebt(client, market, source);
    if (debt.state === "none") return { ok: true };
    return { ok: false, reason: debt.state === "present" ? `Debt appeared in ${market.name} since review (${debt.detail}); the supply position is not moved.` : `Aave debt could not be read right before sending (${debt.detail}).` };
  },

  /**
   * aTokens settle in scaled units: the Safe's balance can differ from the amount sent by a couple of
   * base units, and grows by interest while we read it. Only that is tolerated; a shortfall beyond
   * the rounding tolerance stays a discrepancy.
   */
  interpretVerification(action: MigrationAction, outcome: VerifyOutcome): VerifyOutcome {
    if (outcome.status === "verified") return outcome;
    const v = outcome.verification;
    if (v.safeDelta === null) return outcome;
    const expected = BigInt(v.expected);
    const delta = BigInt(v.safeDelta);
    const before = BigInt(action.safeBalancesBefore?.[0] ?? "0");
    const accrualAllowance = before / 10_000n + AAVE_ROUNDING_TOLERANCE;
    if (delta >= expected - AAVE_ROUNDING_TOLERANCE && delta <= expected + accrualAllowance) {
      return { status: "verified", verification: { ...v, note: `Within Aave rounding/accrual tolerance (received ${delta}, sent ${expected}).` } };
    }
    return outcome;
  },
};
