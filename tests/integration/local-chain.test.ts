/**
 * Saved-Safe workflows on LOCAL chains (Hardhat) seeded with the canonical Safe v1.3.0 bytecode at
 * the canonical addresses: real EVM, real Safe contracts, real executor, throwaway keys. Not live
 * network state. Run with `npm run test:local`.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  pad,
  parseEther,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { proxyFactoryAbi } from "@/lib/abis";
import { getChain } from "@/lib/chains/registry";
import type { SafeProfile } from "@/lib/domain/profile";
import type { Migration } from "@/lib/domain/types";
import { applyAssessment, assessExtension } from "@/lib/services/chain-extension";
import { runMigration, type SendTxRequest, type WalletPort } from "@/lib/services/migration-execution";
import { assembleChainPlan, buildActions, createMigration, needsDeploymentFor, preflightChain } from "@/lib/services/migration-planning";
import { createProfile, exportProfile, importProfile, pinRecipe, resolvePinnedTarget, syncProfileWithMigration } from "@/lib/services/safe-profile";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";
import { loadProfiles, saveProfiles } from "@/lib/state/profile-store";
import { memoryStore } from "@/lib/state/persistence";
import { chainOutcome, migrationReducer } from "@/lib/state/machine";

const run = process.env.RUN_LOCAL_TESTS === "1";
const SEPOLIA = 11155111;
const CHIADO = 10200;
const BASE_SEPOLIA = 84532;
const RPC: Record<number, string> = {
  [SEPOLIA]: process.env.LOCAL_RPC_11155111 ?? "http://127.0.0.1:8545",
  [CHIADO]: process.env.LOCAL_RPC_10200 ?? "http://127.0.0.1:8546",
  [BASE_SEPOLIA]: process.env.LOCAL_RPC_84532 ?? "http://127.0.0.1:8547",
};

const clients = new Map<number, PublicClient>();
function clientFor(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({ chain: getChain(chainId).viemChain, transport: http(RPC[chainId]), pollingInterval: 100 }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}
const rpc = (chainId: number, method: string, params: unknown[]) => clientFor(chainId).request({ method: method as never, params: params as never });

function walletFor(account: ReturnType<typeof privateKeyToAccount>): WalletPort & { sent: SendTxRequest[] } {
  let current = SEPOLIA;
  const sent: SendTxRequest[] = [];
  return {
    sent,
    getAccount: () => account.address,
    getChainId: async () => current,
    switchChain: async (id) => {
      current = id;
    },
    sendTransaction: async (req) => {
      if (req.chainId !== current) throw new Error(`wallet on ${current}, request for ${req.chainId}`);
      const w = createWalletClient({ account, chain: getChain(req.chainId).viemChain, transport: http(RPC[req.chainId]) });
      sent.push(req);
      return w.sendTransaction({ to: req.to, data: req.data, value: req.value, gas: req.gas, maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas, gasPrice: req.gasPrice } as never);
    },
    provider: async () => ({
      request: async ({ method }: { method: string }) => {
        throw Object.assign(new Error(`${method} not supported`), { code: -32601 });
      },
    }),
  };
}

async function execute(m: Migration, wallet: WalletPort) {
  let state = m;
  await runMigration({ wallet, clientFor, dispatch: (e) => (state = migrationReducer(state, e)!), getMigration: () => state, shouldStop: () => false, receiptTimeoutMs: 60_000 });
  return state;
}

/** A fresh profile (random owners → its own address) pinned from the local Sepolia contracts. */
async function freshProfile() {
  const source = privateKeyToAccount(generatePrivateKey());
  const owners = [source.address, privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
  const config = buildSafeConfig(owners, 2, deriveSaltNonce(source.address));
  const pin = await pinRecipe(clientFor(SEPOLIA), SEPOLIA, config, "1.3.0");
  const profile = createProfile({ source: source.address, environment: "testnet", config, recipe: pin.recipe, status: "proposed" });
  for (const id of [SEPOLIA, CHIADO, BASE_SEPOLIA]) await rpc(id, "hardhat_setBalance", [source.address, toHex(parseEther("10"))]);
  return { source, profile };
}

/** Deployment-only run through the real planner and executor (the "Add network" path). */
async function deployOnly(profile: SafeProfile, chainId: number, source: ReturnType<typeof privateKeyToAccount>) {
  const client = clientFor(chainId);
  const target = await resolvePinnedTarget(chainId, client, profile);
  const actions = buildActions(chainId, [], needsDeploymentFor(target));
  const pre = await preflightChain({ client, source: source.address, config: profile.original, target, actions, capability: undefined });
  const plan = assembleChainPlan(pre, actions, { verifiedOwnerCount: 0, threshold: profile.original.threshold, walletChainId: chainId });
  expect(plan.blockers).toEqual([]);
  const m = createMigration({ id: `ext-${chainId}-${Date.now()}`, source: source.address, environment: "testnet", safeConfig: profile.original, verifiedOwners: [], plans: [plan], profileId: profile.id, deploymentCommitment: profile.commitment, purpose: "extension" });
  const done = await execute(m, walletFor(source));
  expect(done.chains.map(chainOutcome)).toEqual(["completed"]);
  return syncProfileWithMigration(profile, done);
}

describe.runIf(run)("saved Safe: add network (local canonical chains)", () => {
  it("creates on chain A, survives reload and export/import, then extends to chain B at the same address", async () => {
    const { source, profile } = await freshProfile();
    let p = await deployOnly(profile, SEPOLIA, source);
    expect(p.deployments.map((d) => [d.chainId, d.how])).toEqual([[SEPOLIA, "deployed"]]);

    const store = memoryStore();
    saveProfiles(store, source.address, [p]);
    const [reloaded] = loadProfiles(store, source.address).profiles;
    const imported = importProfile(exportProfile(reloaded!), { source: source.address, environment: "testnet" });
    expect(imported.ok).toBe(true);
    p = imported.ok ? imported.profile : p;

    const a = await assessExtension({ profile: p, chainId: CHIADO, clientFor });
    expect(a).toMatchObject({ action: "deploy", blockers: [] });
    expect(a.target.predictedAddress).toBe(p.safeAddress);
    p = await deployOnly(applyAssessment(p, a), CHIADO, source);
    expect(p.deployments.map((d) => d.chainId).sort()).toEqual([CHIADO, SEPOLIA].sort());
    expect(await clientFor(CHIADO).getCode({ address: p.safeAddress! })).toMatch(/^0x.{10,}/);
  }, 120_000);

  it("reuses a matching Safe someone else already deployed, without a transaction", async () => {
    const { source, profile } = await freshProfile();
    const p = await deployOnly(profile, SEPOLIA, source);
    // Anyone can deploy the same recipe: a third party does so on Base Sepolia.
    const stranger = privateKeyToAccount(generatePrivateKey());
    await rpc(BASE_SEPOLIA, "hardhat_setBalance", [stranger.address, toHex(parseEther("1"))]);
    const w = createWalletClient({ account: stranger, chain: getChain(BASE_SEPOLIA).viemChain, transport: http(RPC[BASE_SEPOLIA]) });
    const hash = await w.sendTransaction({
      to: p.recipe!.factory,
      data: encodeFunctionData({ abi: proxyFactoryAbi, functionName: "createProxyWithNonce", args: [p.recipe!.singleton, p.recipe!.initializer, BigInt(p.recipe!.saltNonce)] }),
    } as never);
    await clientFor(BASE_SEPOLIA).waitForTransactionReceipt({ hash });

    const a = await assessExtension({ profile: p, chainId: BASE_SEPOLIA, clientFor });
    expect(a.action).toBe("reuse");
    const next = applyAssessment(p, a);
    expect(next.deployments.find((d) => d.chainId === BASE_SEPOLIA)).toMatchObject({ how: "existing", txHash: null });
  }, 120_000);

  it("blocks extension when governance diverged on a known deployment", async () => {
    const { source, profile } = await freshProfile();
    const p = await deployOnly(profile, SEPOLIA, source);
    // Simulate an owner-approved threshold change (Safe v1.3.0 stores the threshold in slot 4).
    await rpc(SEPOLIA, "hardhat_setStorageAt", [p.safeAddress, pad("0x4", { size: 32 }), pad("0x1", { size: 32 })]);
    const a = await assessExtension({ profile: p, chainId: CHIADO, clientFor });
    expect(a.action).toBe("blocked");
    expect(a.blockers.join(" ")).toMatch(/install the ORIGINAL owners/);
    expect(a.snapshots[0]).toMatchObject({ chainId: SEPOLIA, threshold: 1, matchesOriginal: false });
  }, 120_000);

  it("blocks a conflicting contract at the address and a network missing the pinned version, without renegotiating", async () => {
    const { source, profile } = await freshProfile();
    const p = await deployOnly(profile, SEPOLIA, source);

    await rpc(CHIADO, "hardhat_setCode", [p.safeAddress, "0x6080604052600080fd"]);
    const conflict = await assessExtension({ profile: p, chainId: CHIADO, clientFor });
    expect(conflict.action).toBe("blocked");
    expect(conflict.target.status).toBe("deployed_mismatch");
    await rpc(CHIADO, "hardhat_setCode", [p.safeAddress, "0x"]);

    const fixture = JSON.parse(readFileSync(new URL("../fixtures/safe-v1.3.0-runtime.json", import.meta.url), "utf8")) as { contracts: Record<string, { address: Address; runtimeCode: Hex }> };
    const singleton = fixture.contracts.singleton!;
    await rpc(BASE_SEPOLIA, "hardhat_setCode", [singleton.address, "0x"]);
    try {
      const a = await assessExtension({ profile: p, chainId: BASE_SEPOLIA, clientFor });
      expect(a.action).toBe("blocked");
      expect(a.target).toMatchObject({ status: "incompatible", safeVersion: "1.3.0", predictedAddress: null });
      expect(a.blockers.join(" ")).toMatch(/will not switch versions/);
    } finally {
      await rpc(BASE_SEPOLIA, "hardhat_setCode", [singleton.address, singleton.runtimeCode]);
    }
  }, 120_000);

  it("rejects a tampered recipe before any chain is touched", async () => {
    const { source, profile } = await freshProfile();
    const text = exportProfile(profile).replace(profile.recipe!.saltNonce, "1");
    expect(importProfile(text, { source: source.address, environment: "testnet" }).ok).toBe(false);
    const forged = { ...profile, safeAddress: getAddress(`0x${"12".repeat(20)}`) };
    expect((await resolvePinnedTarget(CHIADO, clientFor(CHIADO), forged)).status).toBe("error");
  }, 60_000);
});

describe.runIf(run)("saved Safe: late arrivals and sweeps (local canonical chains)", () => {
  it("detects new assets after a run, survives reload, sweeps them without redeploying, then settles", async () => {
    const { source, profile } = await freshProfile();
    let p = await deployOnly(profile, SEPOLIA, source);
    const client = clientFor(SEPOLIA);

    // Assets arrive at the source after the first run.
    const art = (await import("@/lib/testnet/artifacts.json")).default.artifacts;
    const w = createWalletClient({ account: source, chain: getChain(SEPOLIA).viemChain, transport: http(RPC[SEPOLIA]) });
    const deploy = async (name: "SampleToken" | "SampleNFT", args: readonly unknown[]) => {
      const hash = await w.deployContract({ abi: art[name].abi as never, bytecode: art[name].bytecode as Hex, args: args as never });
      return getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
    };
    const token = await deploy("SampleToken", ["Late Token", "LATE", 18, 10n ** 21n]);
    const nft = await deploy("SampleNFT", ["Late NFT", "LNFT", false, 1n]);
    const imports = [
      { chainId: SEPOLIA, standard: "erc20" as const, contract: token, tokenId: null },
      { chainId: SEPOLIA, standard: "erc721" as const, contract: nft, tokenId: "1" },
    ];
    const { discoverNetwork } = await import("@/lib/services/discovery/asset-discovery");
    const { applyScan, ignoreArrival } = await import("@/lib/services/late-arrivals");
    const scan1 = await discoverNetwork({ chainId: SEPOLIA, owner: source.address, client, manualImports: imports });
    const s1 = applyScan(p.watch, { [SEPOLIA]: scan1 });
    p = { ...p, manualImports: imports, watch: s1.watch };
    const ids = s1.watch.pending.map((x) => x.assetId);
    expect(ids).toEqual(expect.arrayContaining([`${SEPOLIA}:erc20:${token.toLowerCase()}`, `${SEPOLIA}:erc721:${nft.toLowerCase()}:1`]));

    // Reload: pending items persist; an unreachable network does not clear them.
    const store = memoryStore();
    saveProfiles(store, source.address, [p]);
    p = loadProfiles(store, source.address).profiles[0]!;
    const dead = createPublicClient({ chain: getChain(SEPOLIA).viemChain, transport: http("http://127.0.0.1:9") }) as PublicClient;
    const failed = await discoverNetwork({ chainId: SEPOLIA, owner: source.address, client: dead, manualImports: imports });
    expect(failed.status).toBe("error");
    p = { ...p, watch: applyScan(p.watch, { [SEPOLIA]: failed }).watch };
    expect(p.watch.pending.map((x) => x.assetId).sort()).toEqual([...ids].sort());

    // Ignore the native top-up if any; sweep the token and the NFT through the normal path.
    for (const x of p.watch.pending.filter((x) => x.standard === "native")) p = { ...p, watch: ignoreArrival(p.watch, x) };
    const selected = scan1.assets.filter((a) => a.standard === "erc20" || a.standard === "erc721");
    const target = await resolvePinnedTarget(SEPOLIA, client, p);
    expect(target.status).toBe("deployed_matching");
    const actions = buildActions(SEPOLIA, selected, needsDeploymentFor(target));
    const pre = await preflightChain({ client, source: source.address, config: p.original, target, actions, capability: undefined });
    const plan = assembleChainPlan(pre, actions, { verifiedOwnerCount: 0, threshold: 2, walletChainId: SEPOLIA });
    expect(plan.blockers).toEqual([]);
    expect(plan.needsDeployment).toBe(false);
    const wallet = walletFor(source);
    const m = createMigration({ id: `sweep-${Date.now()}`, source: source.address, environment: "testnet", safeConfig: p.original, verifiedOwners: [], plans: [plan], profileId: p.id, deploymentCommitment: p.commitment, purpose: "sweep" });
    const done = await execute(m, wallet);
    expect(done.chains.map(chainOutcome)).toEqual(["completed"]);
    expect(wallet.sent.some((r) => r.to.toLowerCase() === p.recipe!.factory.toLowerCase())).toBe(false);
    expect(wallet.sent).toHaveLength(2);
    expect(await client.readContract({ address: nft, abi: (await import("viem")).erc721Abi, functionName: "ownerOf", args: [1n] })).toBe(p.safeAddress);

    // After the run, the swept assets are handled and the next check is quiet.
    p = syncProfileWithMigration(p, done);
    const after = applyScan(p.watch, { [SEPOLIA]: await discoverNetwork({ chainId: SEPOLIA, owner: source.address, client, manualImports: imports }) });
    expect(after.watch.pending.filter((x) => x.standard !== "native")).toEqual([]);
  }, 180_000);
});

describe.runIf(run)("exact partial native transfer (local canonical chains)", () => {
  it("moves an exact native amount and leaves the remainder in the source", async () => {
    const { source, profile } = await freshProfile();
    const p = await deployOnly(profile, SEPOLIA, source);
    const client = clientFor(SEPOLIA);
    const balance = await client.getBalance({ address: source.address });
    const exact = parseEther("5");
    const assetId = `${SEPOLIA}:native:native`;
    const assets = [
      {
        id: assetId,
        chainId: SEPOLIA,
        standard: "native" as const,
        contract: null,
        tokenId: null,
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
        balance: balance.toString(),
        usdValue: null,
        imageUrl: null,
        classification: "transferable" as const,
        flags: [],
        reasons: [],
        sources: ["rpc" as const],
        verifiedOnchain: true,
      },
    ];
    const transferIntents = { [assetId]: { mode: "exact" as const, amount: exact.toString() } };
    const target = await resolvePinnedTarget(SEPOLIA, client, p);
    const actions = buildActions(SEPOLIA, assets, needsDeploymentFor(target), { intents: transferIntents });
    const pre = await preflightChain({ client, source: source.address, config: p.original, target, actions, capability: undefined });
    const plan = assembleChainPlan(pre, actions, { verifiedOwnerCount: 0, threshold: 2, walletChainId: SEPOLIA, transferIntents, gasRetention: { applyToAllNetworks: false, defaultEnabled: false, perChain: {} } });
    expect(plan.blockers).toEqual([]);
    const native = plan.actions.find((a) => a.kind === "transfer_native")!;
    expect(native.amounts[0]).toBe(exact.toString());
    const m = createMigration({
      id: `exact-native-${Date.now()}`,
      source: source.address,
      environment: "testnet",
      safeConfig: p.original,
      verifiedOwners: [],
      plans: [plan],
      profileId: p.id,
      deploymentCommitment: p.commitment,
      transferIntents,
    });
    const done = await execute(m, walletFor(source));
    expect(done.chains.map(chainOutcome)).toEqual(["completed"]);
    const safeBal = await client.getBalance({ address: p.safeAddress! });
    expect(safeBal).toBeGreaterThanOrEqual(exact);
    const sourceAfter = await client.getBalance({ address: source.address });
    expect(sourceAfter).toBeLessThan(balance - exact);
    expect(sourceAfter).toBeGreaterThan(0n);
  }, 120_000);
});

describe.runIf(run)("saved Safe: outgoing-transaction evidence (local canonical chains)", () => {
  it("accepts only a successful execution by the Safe itself", async () => {
    const { verifyOutgoingSafeTx } = await import("@/lib/services/readiness");
    const { parseAbi, concat } = await import("viem");
    const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()].map((k) => privateKeyToAccount(k));
    const source = keys[0]!;
    const config = buildSafeConfig(keys.map((k) => k.address), 2, deriveSaltNonce(source.address));
    const pin = await pinRecipe(clientFor(SEPOLIA), SEPOLIA, config, "1.3.0");
    for (const id of [SEPOLIA, CHIADO]) await rpc(id, "hardhat_setBalance", [source.address, toHex(parseEther("10"))]);
    const profile = await deployOnly(createProfile({ source: source.address, environment: "testnet", config, recipe: pin.recipe, status: "proposed" }), SEPOLIA, source);
    const safe = profile.safeAddress!;
    const client = clientFor(SEPOLIA);
    await rpc(SEPOLIA, "hardhat_setBalance", [safe, toHex(parseEther("1"))]);

    // Two owners sign a 1-wei transfer out of the Safe; one of them submits it.
    const abi = parseAbi([
      "function nonce() view returns (uint256)",
      "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
      "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
    ]);
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    const nonce = await client.readContract({ address: safe, abi, functionName: "nonce" });
    const txArgs = [keys[2]!.address, 1n, "0x", 0, 0n, 0n, 0n, zero, zero] as const;
    const hash = await client.readContract({ address: safe, abi, functionName: "getTransactionHash", args: [...txArgs, nonce] });
    const signers = [...keys.slice(0, 2)].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const signatures = concat(await Promise.all(signers.map((k) => k.sign({ hash }))));
    const w = createWalletClient({ account: source, chain: getChain(SEPOLIA).viemChain, transport: http(RPC[SEPOLIA]) });
    const execHash = await w.sendTransaction({ to: safe, data: encodeFunctionData({ abi, functionName: "execTransaction", args: [...txArgs, signatures] }) } as never);
    await client.waitForTransactionReceipt({ hash: execHash });

    const ok = await verifyOutgoingSafeTx({ client, chainId: SEPOLIA, safe, txHash: execHash });
    expect(ok).toMatchObject({ ok: true, evidence: { thresholdAtBlock: 2, txHash: execHash.toLowerCase() } });

    // A plain deposit that touches the Safe is not evidence of threshold signing.
    const deposit = await w.sendTransaction({ to: safe, value: 1n } as never);
    await client.waitForTransactionReceipt({ hash: deposit });
    expect((await verifyOutgoingSafeTx({ client, chainId: SEPOLIA, safe, txHash: deposit })).ok).toBe(false);
    // The right hash on the wrong network is not evidence either.
    expect((await verifyOutgoingSafeTx({ client: clientFor(CHIADO), chainId: CHIADO, safe, txHash: execHash })).ok).toBe(false);
    // Another Safe's execution does not count for this Safe.
    expect((await verifyOutgoingSafeTx({ client, chainId: SEPOLIA, safe: keys[1]!.address, txHash: execHash })).ok).toBe(false);
  }, 180_000);
});
