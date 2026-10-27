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
