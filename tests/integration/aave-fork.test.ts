/**
 * Aave v3 supply-position beta against the REAL Aave v3 Sepolia deployment on a local fork.
 * Required before enabling NEXT_PUBLIC_ENABLE_AAVE_V3_BETA anywhere (see docs/V1_5_IMPLEMENTATION.md).
 *
 *   npm run test:fork:aave      # starts Sepolia/Chiado forks (needs an archive-capable Sepolia RPC)
 *
 * Scenarios: debt-free success, debt-present refusal, unknown debt status, transfer restriction
 * (paused reserve), spoofed metadata, balance accrual between review and sending.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { getChain } from "@/lib/chains/registry";
import type { DiscoveredAsset, Migration } from "@/lib/domain/types";
import artifactsFile from "@/lib/testnet/artifacts.json";
import { discoverNetwork } from "@/lib/services/discovery/asset-discovery";
import { runMigration, type SendTxRequest, type WalletPort } from "@/lib/services/migration-execution";
import { assembleChainPlan, buildActions, createMigration, needsDeploymentFor, preflightChain } from "@/lib/services/migration-planning";
import { aaveV3Adapter, AAVE_V3_MARKETS } from "@/lib/services/protocols/aave-v3";
import { negotiateSafeVersion, resolveChainTarget } from "@/lib/services/safe-deployment";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";
import { chainOutcome, migrationReducer } from "@/lib/state/machine";

vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/config")>();
  return { ...actual, appConfig: { ...actual.appConfig, enableAaveV3Beta: true } };
});

const run = process.env.RUN_AAVE_FORK_TESTS === "1";
const SEPOLIA = 11155111;
const URL = process.env.FORK_SEPOLIA_URL ?? "http://127.0.0.1:8545";
const market = AAVE_V3_MARKETS.find((m) => m.chainId === SEPOLIA)!;
// bgd-labs/aave-address-book src/AaveV3Sepolia.sol
const FAUCET = getAddress("0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D");
const USDC = getAddress("0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8");
const A_USDC = getAddress("0x16dA4541aD1807f4443d92D26044C1147406EB80");
const POOL_CONFIGURATOR = getAddress("0x7Ee60D184C24Ef7AfC1Ec7Be59A0f448A0abd138");
const ACL_MANAGER = getAddress("0x7F2bE3b178deeFF716CD6Ff03Ef79A1dFf360ddD");
const ACL_ADMIN = getAddress("0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00");

const client = createPublicClient({ chain: getChain(SEPOLIA).viemChain, transport: http(URL), pollingInterval: 250 }) as PublicClient;
const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });

const faucetAbi = parseAbi(["function mint(address token, address to, uint256 amount) returns (uint256)"]);
const poolWriteAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
]);

async function fundedAccount() {
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("hardhat_setBalance", [account.address, toHex(parseEther("5"))]);
  const wallet = createWalletClient({ account, chain: getChain(SEPOLIA).viemChain, transport: http(URL) });
  const send = async (to: Address, data: Hex) => client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data } as never) });
  return { account, wallet, send };
}

/** Faucet USDC → supply to Aave → the account holds aUSDC. */
async function supplier(amount = parseUnits("1000", 6)) {
  const a = await fundedAccount();
  await a.send(FAUCET, encodeFunctionData({ abi: faucetAbi, functionName: "mint", args: [USDC, a.account.address, amount] }));
  await a.send(USDC, encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), functionName: "approve", args: [market.pool, amount] }));
  await a.send(market.pool, encodeFunctionData({ abi: poolWriteAbi, functionName: "supply", args: [USDC, amount, a.account.address, 0] }));
  return a;
}

function walletPort(account: ReturnType<typeof privateKeyToAccount>): WalletPort & { sent: SendTxRequest[] } {
  const sent: SendTxRequest[] = [];
  const w = createWalletClient({ account, chain: getChain(SEPOLIA).viemChain, transport: http(URL) });
  return {
    sent,
    getAccount: () => account.address,
    getChainId: async () => SEPOLIA,
    switchChain: async () => {},
    sendTransaction: async (req) => {
      sent.push(req);
      return w.sendTransaction({ to: req.to, data: req.data, value: req.value, gas: req.gas, maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas } as never);
    },
    provider: async () => ({ request: async () => Promise.reject(Object.assign(new Error("unsupported"), { code: -32601 })) }),
  };
}

async function discoverEnriched(owner: Address, c: PublicClient = client) {
  const d = await discoverNetwork({ chainId: SEPOLIA, owner, client: c, manualImports: [{ chainId: SEPOLIA, standard: "erc20", contract: A_USDC, tokenId: null }] });
  return aaveV3Adapter.enrich({ chainId: SEPOLIA, source: owner, assets: d.assets, client: c });
}

async function migrate(owner: ReturnType<typeof privateKeyToAccount>, assets: DiscoveredAsset[], beforeSend?: () => Promise<void>) {
  const config = buildSafeConfig([owner.address, privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address], 2, deriveSaltNonce(owner.address));
  const negotiation = await negotiateSafeVersion([SEPOLIA], () => client);
  const target = await resolveChainTarget(SEPOLIA, client, config, negotiation.perChain[SEPOLIA]!);
  const actions = buildActions(SEPOLIA, assets, needsDeploymentFor(target));
  const pre = await preflightChain({ client, source: owner.address, config, target, actions, capability: undefined });
  const plan = assembleChainPlan(pre, actions, { verifiedOwnerCount: 0, threshold: 2, walletChainId: SEPOLIA });
  let state: Migration = createMigration({ id: `aave-${Date.now()}`, source: owner.address, environment: "testnet", safeConfig: config, verifiedOwners: [], plans: [plan] });
  await beforeSend?.();
  await runMigration({ wallet: walletPort(owner), clientFor: () => client, dispatch: (e) => (state = migrationReducer(state, e)!), getMigration: () => state, shouldStop: () => false, receiptTimeoutMs: 60_000 });
  return { state, plan, safe: target.predictedAddress! };
}

describe.runIf(run)("Aave v3 supply beta on a Sepolia fork", () => {
  it("moves a debt-free aUSDC position into the Safe and verifies it", async () => {
    const { account } = await supplier();
    const assets = await discoverEnriched(account.address);
    const a = assets.find((x) => x.contract === A_USDC)!;
    expect(a).toMatchObject({ classification: "transferable", protocol: { adapter: "aave-v3" } });
    const { state, safe } = await migrate(account, assets.filter((x) => x.contract === A_USDC));
    const action = state.chains[0]!.actions.find((x) => x.contract === A_USDC)!;
    expect(action.status).toBe("verified");
    expect(chainOutcome(state.chains[0]!)).toBe("completed");
    const inSafe = await client.readContract({ address: A_USDC, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
    expect(inSafe).toBeGreaterThanOrEqual(parseUnits("1000", 6) - 2n);
  }, 300_000);

  it("refuses a position whose owner has debt in the pool", async () => {
    const a = await supplier();
    await a.send(market.pool, encodeFunctionData({ abi: poolWriteAbi, functionName: "borrow", args: [USDC, parseUnits("10", 6), 2n, 0, a.account.address] }));
    const assets = await discoverEnriched(a.account.address);
    expect(assets.find((x) => x.contract === A_USDC)).toMatchObject({ classification: "specialized" });
  }, 300_000);

  it("blocks at submission when debt appears after review", async () => {
    const a = await supplier();
    const assets = (await discoverEnriched(a.account.address)).filter((x) => x.contract === A_USDC);
    expect(assets[0]!.classification).toBe("transferable");
    const { state } = await migrate(a.account, assets, async () => {
      await a.send(market.pool, encodeFunctionData({ abi: poolWriteAbi, functionName: "borrow", args: [USDC, parseUnits("10", 6), 2n, 0, a.account.address] }));
    });
    const action = state.chains[0]!.actions.find((x) => x.contract === A_USDC)!;
    expect(action.status).toBe("needs_attention");
    expect(action.error?.message).toMatch(/Debt appeared/);
  }, 300_000);

  it("treats an unreadable debt status as blocking", async () => {
    const a = await supplier();
    const flaky = new Proxy(client, {
      get(target, prop) {
        if (prop === "readContract") {
          return async (args: { functionName: string }) => {
            if (args.functionName === "getUserAccountData") throw new Error("rpc timeout");
            return (target.readContract as (x: unknown) => Promise<unknown>)(args);
          };
        }
        return Reflect.get(target, prop);
      },
    }) as PublicClient;
    const assets = await discoverEnriched(a.account.address, flaky);
    expect(assets.find((x) => x.contract === A_USDC)).toMatchObject({ classification: "specialized" });
  }, 300_000);

  it("keeps a look-alike token with Aave metadata specialized", async () => {
    const a = await fundedAccount();
    const art = artifactsFile.artifacts.SampleToken;
    const hash = await a.wallet.deployContract({ abi: art.abi as Abi, bytecode: art.bytecode as Hex, args: ["Aave Ethereum USDC", "aEthUSDC", 6, parseUnits("100", 6)] } as never);
    const fake = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
    const d = await discoverNetwork({ chainId: SEPOLIA, owner: a.account.address, client, manualImports: [{ chainId: SEPOLIA, standard: "erc20", contract: fake, tokenId: null }] });
    const enriched = await aaveV3Adapter.enrich({ chainId: SEPOLIA, source: a.account.address, assets: d.assets, client });
    expect(enriched.find((x) => x.contract === fake)).toMatchObject({ classification: "specialized" });
  }, 300_000);

  it("excludes a position whose reserve is paused (transfer restriction)", async () => {
    const a = await supplier();
    await rpc("hardhat_impersonateAccount", [ACL_ADMIN]);
    await rpc("hardhat_setBalance", [ACL_ADMIN, toHex(parseEther("1"))]);
    const admin = createWalletClient({ account: ACL_ADMIN, chain: getChain(SEPOLIA).viemChain, transport: http(URL) });
    const exec = async (to: Address, data: Hex) => client.waitForTransactionReceipt({ hash: await admin.sendTransaction({ to, data } as never) });
    await exec(ACL_MANAGER, encodeFunctionData({ abi: parseAbi(["function addPoolAdmin(address)"]), functionName: "addPoolAdmin", args: [ACL_ADMIN] }));
    await exec(POOL_CONFIGURATOR, encodeFunctionData({ abi: parseAbi(["function setReservePause(address asset, bool paused)"]), functionName: "setReservePause", args: [USDC, true] }));
    try {
      const assets = (await discoverEnriched(a.account.address)).filter((x) => x.contract === A_USDC);
      const { plan } = await migrate(a.account, assets);
      expect(plan.excluded.map((e) => e.action.contract)).toContain(A_USDC);
    } finally {
      await exec(POOL_CONFIGURATOR, encodeFunctionData({ abi: parseAbi(["function setReservePause(address asset, bool paused)"]), functionName: "setReservePause", args: [USDC, false] }));
    }
  }, 300_000);

  it("accepts interest accrued between review and sending without hiding a shortfall", async () => {
    const a = await supplier(parseUnits("5000", 6));
    const assets = (await discoverEnriched(a.account.address)).filter((x) => x.contract === A_USDC);
    const { state } = await migrate(a.account, assets, async () => {
      await rpc("evm_increaseTime", [30 * 24 * 3600]);
      await rpc("evm_mine", []);
    });
    const action = state.chains[0]!.actions.find((x) => x.contract === A_USDC)!;
    // Either within the 0.5% re-confirmation band (verified) or flagged for renewed confirmation.
    expect(["verified", "needs_attention"]).toContain(action.status);
    if (action.status === "needs_attention") expect(action.error?.code).toBe("amount_changed");
  }, 300_000);
});
