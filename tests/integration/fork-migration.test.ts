/**
 * End-to-end migration against LOCAL FORKS of Sepolia and Chiado (real Safe contracts, real EVM
 * execution, throwaway keys). Nothing here touches the live networks' state.
 *
 *   FORK_CHAIN_ID=11155111 FORK_URL=<sepolia rpc> npx hardhat node --port 8545
 *   FORK_CHAIN_ID=10200    FORK_URL=<chiado rpc>  npx hardhat node --port 8546
 *   RUN_FORK_TESTS=1 npx vitest run tests/integration/fork-migration.test.ts
 *
 * See docs/TESTNET_GUIDE.md for the hardhat config.
 */
import { createRequire } from "node:module";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  erc721Abi,
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
import { erc1155Abi } from "@/lib/abis";
import type { ChainCapability } from "@/lib/services/transaction-capability";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { getChain } from "@/lib/chains/registry";
import type { DiscoveredAsset, Migration } from "@/lib/domain/types";
import artifactsFile from "@/lib/testnet/artifacts.json";
import { discoverNetwork, type ManualImport } from "@/lib/services/discovery/asset-discovery";
import { isAutoSelectable } from "@/lib/services/discovery/classification";
import { runMigration, type SendTxRequest, type WalletPort } from "@/lib/services/migration-execution";
import { assembleChainPlan, buildActions, createMigration, preflightChain, type ChainPlan } from "@/lib/services/migration-planning";
import { compareSafeToConfig, inspectSafe } from "@/lib/services/onchain-verification";
import { negotiateSafeVersion, resolveChainTarget } from "@/lib/services/safe-deployment";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";
import { chainOutcome, migrationReducer, type MigrationEvent } from "@/lib/state/machine";
import type { SafeConfig } from "@/lib/domain/types";

const run = process.env.RUN_FORK_TESTS === "1";
const SEPOLIA = 11155111;
const CHIADO = 10200;
const FORKS: Record<number, string> = {
  [SEPOLIA]: process.env.FORK_SEPOLIA_URL ?? "http://127.0.0.1:8545",
  [CHIADO]: process.env.FORK_CHIADO_URL ?? "http://127.0.0.1:8546",
};
const CHAINS = [SEPOLIA, CHIADO];

const clients = new Map<number, PublicClient>();
function clientFor(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({ chain: getChain(chainId).viemChain, transport: http(FORKS[chainId]), pollingInterval: 250 }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

const account = privateKeyToAccount(generatePrivateKey());
const SOURCE = account.address;
const wallets = Object.fromEntries(
  CHAINS.map((id) => [id, createWalletClient({ account, chain: getChain(id).viemChain, transport: http(FORKS[id]) })]),
);

type ArtifactName = keyof typeof artifactsFile.artifacts;
type ForkWallet = (typeof wallets)[number];
async function deploy(chainId: number, name: ArtifactName, args: readonly unknown[], deployer: ForkWallet = wallets[chainId]!): Promise<Address> {
  const art = artifactsFile.artifacts[name];
  const hash = await deployer.deployContract({ abi: art.abi as Abi, bytecode: art.bytecode as Hex, args });
  const r = await clientFor(chainId).waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress!);
}

/** A wallet port that behaves like a conventional EOA wallet: one chain at a time, no EIP-5792. */
function eoaWallet(reject?: (req: SendTxRequest) => boolean): WalletPort & { sent: SendTxRequest[] } {
  let current = SEPOLIA;
  const sent: SendTxRequest[] = [];
  return {
    sent,
    getAccount: () => SOURCE,
    getChainId: async () => current,
    switchChain: async (id) => {
      current = id;
    },
    sendTransaction: async (req) => {
      if (req.chainId !== current) throw new Error(`wallet is on ${current}, request for ${req.chainId}`);
      if (reject?.(req)) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      const hash = await wallets[req.chainId]!.sendTransaction({
        to: req.to,
        data: req.data,
        value: req.value,
        gas: req.gas,
        ...(req.gasPrice !== undefined
          ? { gasPrice: req.gasPrice }
          : { maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas }),
      });
      sent.push(req);
      return hash;
    },
    provider: async () => ({
      request: async ({ method }: { method: string }) => {
        throw Object.assign(new Error(`${method} not supported`), { code: -32601 });
      },
    }),
  };
}

async function planAll(
  config: SafeConfig,
  imports: ManualImport[],
  opts: { source?: Address; chains?: number[]; capability?: ChainCapability } = {},
) {
  const source = opts.source ?? SOURCE;
  const negotiation = await negotiateSafeVersion(CHAINS, clientFor);
  const plans: ChainPlan[] = [];
  const discovered: Record<number, DiscoveredAsset[]> = {};
  for (const chainId of opts.chains ?? CHAINS) {
    const client = clientFor(chainId);
    const target = await resolveChainTarget(chainId, client, config, negotiation.perChain[chainId]!);
    const discovery = await discoverNetwork({ chainId, owner: source, client, manualImports: imports.filter((i) => i.chainId === chainId) });
    expect(discovery.status, discovery.errors.join(" | ")).toBe("ok");
    discovered[chainId] = discovery.assets;
    const selected = discovery.assets.filter((a) => isAutoSelectable(a.classification));
    const actions = buildActions(chainId, selected, target.status !== "deployed_matching");
    const pre = await preflightChain({ client, source, config, target, actions, capability: opts.capability });
    plans.push(assembleChainPlan(pre, actions, { verifiedOwnerCount: 0, threshold: config.threshold, walletChainId: SEPOLIA }));
  }
  return { negotiation, plans, discovered };
}

const newMigration = (plans: ChainPlan[], cfg: SafeConfig, id: string, source: Address = SOURCE) =>
  createMigration({ id, source, environment: "testnet", safeConfig: cfg, verifiedOwners: [], plans });

/**
 * Runs the real executor. `crashWhen` freezes the persisted state at the first matching event and
 * stops the run, which is what a closed tab looks like to the next session.
 */
async function execute(initial: Migration, wallet: WalletPort & { sent: SendTxRequest[] } = eoaWallet(), crashWhen?: (e: MigrationEvent) => boolean) {
  let state = initial;
  let crashed = false;
  await runMigration({
    wallet,
    clientFor,
    dispatch: (e) => {
      if (crashed) return;
      state = migrationReducer(state, e)!;
      if (crashWhen?.(e)) crashed = true;
    },
    getMigration: () => state,
    shouldStop: () => crashed,
    receiptTimeoutMs: 60_000,
  });
  return { state: JSON.parse(JSON.stringify(state)) as Migration, wallet };
}

const owners = [SOURCE, privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
const config = buildSafeConfig(owners, 2, deriveSaltNonce(SOURCE));
const isTransferTo = (contract: Address) => (req: SendTxRequest) => req.to.toLowerCase() === contract.toLowerCase();
const tokens: Record<number, { usd: Address; fee: Address; restricted: Address }> = {};

describe.runIf(run)("fork migration: Sepolia + Chiado", () => {
  it("funds the source and deploys sample tokens on both forks", async () => {
    for (const chainId of CHAINS) {
      await clientFor(chainId).request({ method: "hardhat_setBalance" as never, params: [SOURCE, `0x${parseEther("2").toString(16)}`] as never });
      tokens[chainId] = {
        usd: await deploy(chainId, "SampleToken", ["Migrator Demo USD", "mUSD", 6, parseUnits("1000000", 6)]),
        fee: await deploy(chainId, "FeeOnTransferToken", [parseUnits("1000", 18)]),
        restricted: await deploy(chainId, "RestrictedToken", [parseUnits("1000", 18)]),
      };
    }
  }, 120_000);

  it("plans, deploys the same Safe on both chains, migrates and verifies onchain", async () => {
    const imports: ManualImport[] = CHAINS.flatMap((chainId) =>
      Object.values(tokens[chainId]!).map((contract) => ({ chainId, standard: "erc20" as const, contract, tokenId: null })),
    );
    const { negotiation, plans } = await planAll(config, imports);
    expect(negotiation.commonVersion).toBe("1.3.0");

    const [sep, chi] = plans;
    expect(sep!.safeAddress).toBe(chi!.safeAddress);
    for (const p of plans) {
      expect(p.blockers).toEqual([]);
      expect(p.executable).toBe(true);
      expect(p.needsDeployment).toBe(true);
      // The restricted token fails simulation and is excluded instead of being sent.
      expect(p.excluded.map((e) => e.action.contract)).toContain(tokens[p.chainId]!.restricted);
      expect(p.actions.map((a) => a.kind)).toEqual(["deploy_safe", "transfer_erc20", "transfer_erc20", "transfer_native"]);
    }

    const { state, wallet } = await execute(newMigration(plans, config, "fork-1"));
    const safe = sep!.safeAddress!;

    for (const chainId of CHAINS) {
      const c = state.chains.find((x) => x.chainId === chainId)!;
      const byContract = Object.fromEntries(c.actions.map((a) => [a.contract ?? a.kind, a]));
      expect(byContract.deploy_safe!.status).toBe("verified");
      expect(byContract[tokens[chainId]!.usd]!.status).toBe("verified");
      expect(byContract[tokens[chainId]!.fee]!.status).toBe("verified_with_discrepancy");
      expect(byContract.transfer_native!.status).toBe("verified");
      for (const a of c.actions) expect(a.txHash).toMatch(/^0x[0-9a-f]{64}$/);

      const client = clientFor(chainId);
      const inspection = await inspectSafe(client, safe);
      expect(inspection.isSafe).toBe(true);
      expect(inspection.threshold).toBe(2);
      expect(compareSafeToConfig(inspection, config, c.contracts)).toEqual([]);

      const usd = await client.readContract({ address: tokens[chainId]!.usd, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
      expect(usd).toBe(parseUnits("1000000", 6));
      const restrictedLeft = await client.readContract({ address: tokens[chainId]!.restricted, abi: erc20Abi, functionName: "balanceOf", args: [SOURCE] });
      expect(restrictedLeft).toBe(parseUnits("1000", 18));

      const safeNative = await client.getBalance({ address: safe });
      const sourceNative = await client.getBalance({ address: SOURCE });
      expect(safeNative).toBeGreaterThan(parseEther("1.9"));
      expect(sourceNative).toBeLessThan(parseEther("0.05"));
    }
    expect(wallet.sent).toHaveLength(8);
  }, 300_000);

  it("re-planning skips deployment for the existing matching Safe and moves only new assets", async () => {
    const extra: Record<number, Address> = {};
    for (const chainId of CHAINS) {
      await clientFor(chainId).request({ method: "hardhat_setBalance" as never, params: [SOURCE, `0x${parseEther("1").toString(16)}`] as never });
      extra[chainId] = await deploy(chainId, "SampleToken", ["Migrator Demo Token", "MDT", 18, parseUnits("5000", 18)]);
    }
    const imports: ManualImport[] = CHAINS.map((chainId) => ({ chainId, standard: "erc20" as const, contract: extra[chainId]!, tokenId: null }));
    const { plans } = await planAll(config, imports);
    for (const p of plans) {
      expect(p.needsDeployment).toBe(false);
      expect(p.actions.map((a) => `${a.kind}:${a.status}`)).toEqual(["deploy_safe:skipped", "transfer_erc20:planned", "transfer_native:planned"]);
    }
    const { state, wallet } = await execute(newMigration(plans, config, "fork-2"));
    expect(wallet.sent).toHaveLength(4);
    for (const c of state.chains) {
      expect(chainOutcome(c)).toBe("completed");
      const bal = await clientFor(c.chainId).readContract({ address: extra[c.chainId]!, abi: erc20Abi, functionName: "balanceOf", args: [c.safeAddress] });
      expect(bal).toBe(parseUnits("5000", 18));
    }
  }, 300_000);

  it("stops on a rejected transfer, then retries without redeploying or resending confirmed actions", async () => {
    const cfg = buildSafeConfig(owners, 2, deriveSaltNonce(SOURCE, 1));
    const token: Record<number, Address> = {};
    for (const chainId of CHAINS) {
      await clientFor(chainId).request({ method: "hardhat_setBalance" as never, params: [SOURCE, `0x${parseEther("1").toString(16)}`] as never });
      token[chainId] = await deploy(chainId, "SampleToken", ["Retry Token", "RTY", 18, parseUnits("10", 18)]);
    }
    const { plans } = await planAll(cfg, CHAINS.map((chainId) => ({ chainId, standard: "erc20" as const, contract: token[chainId]!, tokenId: null })));
    expect(plans.every((p) => p.needsDeployment)).toBe(true);

    const first = await execute(newMigration(plans, cfg, "fork-3"), eoaWallet(isTransferTo(token[SEPOLIA]!)));
    const sep = first.state.chains.find((c) => c.chainId === SEPOLIA)!;
    expect(sep.actions.map((a) => a.status)).toEqual(["verified", "rejected", "planned"]);
    expect(chainOutcome(first.state.chains.find((c) => c.chainId === CHIADO)!)).toBe("not_started");
    expect(first.wallet.sent).toHaveLength(1);

    const retry = await execute(migrationReducer(first.state, { type: "RETRY_FAILED" })!);
    // Sepolia: ERC-20 + native. Chiado: deploy + ERC-20 + native. No second Sepolia deployment.
    expect(retry.wallet.sent.map((r) => r.chainId)).toEqual([SEPOLIA, SEPOLIA, CHIADO, CHIADO, CHIADO]);
    for (const c of retry.state.chains) expect(chainOutcome(c)).toBe("completed");
  }, 300_000);

  it("resumes after the session dies mid-transfer without resending the mined transaction", async () => {
    const token: Record<number, Address> = {};
    for (const chainId of CHAINS) {
      await clientFor(chainId).request({ method: "hardhat_setBalance" as never, params: [SOURCE, `0x${parseEther("1").toString(16)}`] as never });
      token[chainId] = await deploy(chainId, "SampleToken", ["Resume Token", "RSM", 18, parseUnits("7", 18)]);
    }
    const { plans } = await planAll(config, CHAINS.map((chainId) => ({ chainId, standard: "erc20" as const, contract: token[chainId]!, tokenId: null })));
    const crashed = await execute(
      newMigration(plans, config, "fork-4"),
      eoaWallet(),
      (e) => e.type === "ACTION_PATCH" && e.chainId === SEPOLIA && e.actionId.includes("transfer_erc20") && !!e.patch.txHash,
    );
    const pending = crashed.state.chains.find((c) => c.chainId === SEPOLIA)!.actions.find((a) => a.kind === "transfer_erc20")!;
    expect(pending.status).toBe("submitted");
    expect(crashed.wallet.sent).toHaveLength(1);

    const resumed = await execute(crashed.state);
    const resent = resumed.wallet.sent.filter((r) => r.chainId === SEPOLIA && isTransferTo(token[SEPOLIA]!)(r));
    expect(resent).toEqual([]);
    for (const c of resumed.state.chains) {
      expect(chainOutcome(c)).toBe("completed");
      const bal = await clientFor(c.chainId).readContract({ address: token[c.chainId]!, abi: erc20Abi, functionName: "balanceOf", args: [c.safeAddress] });
      expect(bal).toBe(parseUnits("7", 18));
    }
  }, 300_000);
});

/* ------------------------- EIP-7702 + EIP-5792 batching ------------------------ */

/**
 * TEST-ONLY delegate standing in for a wallet's own audited EIP-7702 contract (e.g. MetaMask's).
 * The app never deploys or chooses a delegate; it only calls wallet_sendCalls.
 */
const EXECUTOR_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract TestBatchExecutor {
    struct Call { address to; uint256 value; bytes data; }
    function execute(Call[] calldata calls) external payable {
        require(msg.sender == address(this), "only self");
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
    receive() external payable {}
}`;

const safeOf = (p: ChainPlan) => p.safeAddress!;

const EXECUTOR_ABI = parseAbi(["function execute((address to, uint256 value, bytes data)[] calls) payable"]);

function compileExecutor(): Hex {
  const solc = createRequire(import.meta.url)("solc");
  const input = {
    language: "Solidity",
    sources: { "TestBatchExecutor.sol": { content: EXECUTOR_SOURCE } },
    settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  return `0x${out.contracts["TestBatchExecutor.sol"].TestBatchExecutor.evm.bytecode.object}`;
}

/**
 * A wallet that implements EIP-5792 the way 7702-capable wallets do: the first wallet_sendCalls
 * upgrades the EOA with a type-4 authorization, then every call runs inside ONE transaction.
 */
function batchingWallet(wc: ForkWallet, executor: Address) {
  const address = wc.account.address;
  const sent: SendTxRequest[] = [];
  const batches: { calls: number; hash: Hex; upgraded: boolean }[] = [];
  const wallet: WalletPort = {
    getAccount: () => address,
    getChainId: async () => SEPOLIA,
    switchChain: async (id) => {
      if (id !== SEPOLIA) throw new Error("test wallet is Sepolia-only");
    },
    sendTransaction: async (req) => {
      sent.push(req);
      return wc.sendTransaction({ to: req.to, data: req.data, value: req.value, gas: req.gas });
    },
    provider: async () => ({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "wallet_getCapabilities") return { [toHex(SEPOLIA)]: { atomic: { status: "ready" } } };
        if (method === "wallet_sendCalls") {
          const [p] = params as [{ atomicRequired: boolean; calls: { to: Address; data: Hex; value: Hex }[] }];
          if (!p.atomicRequired) throw new Error("expected atomicRequired");
          const code = await clientFor(SEPOLIA).getCode({ address });
          const needsUpgrade = !code || code === "0x";
          const authorizationList = needsUpgrade ? [await wc.signAuthorization({ contractAddress: executor, executor: "self" })] : undefined;
          const data = encodeFunctionData({
            abi: EXECUTOR_ABI,
            functionName: "execute",
            args: [p.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }))],
          });
          const hash = await wc.sendTransaction({ to: address, data, authorizationList });
          batches.push({ calls: p.calls.length, hash, upgraded: needsUpgrade });
          return { id: hash };
        }
        if (method === "wallet_getCallsStatus") {
          const hash = (params as Hex[])[0]!;
          const r = await clientFor(SEPOLIA).waitForTransactionReceipt({ hash });
          const ok = r.status === "success";
          return { status: ok ? 200 : 500, atomic: true, receipts: [{ transactionHash: r.transactionHash, status: ok ? "0x1" : "0x0", blockNumber: toHex(r.blockNumber) }] };
        }
        throw Object.assign(new Error(`${method} not supported`), { code: -32601 });
      },
    }),
  };
  return Object.assign(wallet, { sent, batches });
}

describe.runIf(run)("fork migration: one EIP-7702 batch deploys a 3-of-5 Safe and moves every asset type", () => {
  it("deploys the Safe and transfers ERC-20, ERC-721, ERC-1155 and native in a single transaction", async () => {
    const client = clientFor(SEPOLIA);
    const batcher = privateKeyToAccount(generatePrivateKey());
    const wc = createWalletClient({ account: batcher, chain: getChain(SEPOLIA).viemChain, transport: http(FORKS[SEPOLIA]) });
    await client.request({ method: "hardhat_setBalance" as never, params: [batcher.address, `0x${parseEther("2").toString(16)}`] as never });

    const executorHash = await wc.deployContract({ abi: [], bytecode: compileExecutor() });
    const executor = getAddress((await client.waitForTransactionReceipt({ hash: executorHash })).contractAddress!);
    const usd = await deploy(SEPOLIA, "SampleToken", ["Batch USD", "bUSD", 6, parseUnits("2500", 6)], wc);
    const nft = await deploy(SEPOLIA, "SampleNFT", ["Batch NFT", "BNFT", false, 3n], wc);
    const multi = await deploy(SEPOLIA, "SampleMultiToken", [], wc);
    const imports: ManualImport[] = [
      { chainId: SEPOLIA, standard: "erc20", contract: usd, tokenId: null },
      ...["1", "2", "3"].map((tokenId) => ({ chainId: SEPOLIA, standard: "erc721" as const, contract: nft, tokenId })),
      ...["1", "2", "3"].map((tokenId) => ({ chainId: SEPOLIA, standard: "erc1155" as const, contract: multi, tokenId })),
    ];

    const others = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()).address);
    const cfg = buildSafeConfig([batcher.address, ...others], 3, deriveSaltNonce(batcher.address));
    const capability: ChainCapability = { chainId: SEPOLIA, atomic: "ready", source: "wallet", note: null };
    const { plans } = await planAll(cfg, imports, { source: batcher.address, chains: [SEPOLIA], capability });
    const plan = plans[0]!;
    expect(plan.blockers).toEqual([]);
    expect(plan.strategy).toBe("atomic_batch");
    expect(plan.confirmations).toMatchObject({ deployment: 0, transfers: 2, total: 2, deploymentInBatch: true });
    expect(new Set(plan.actions.map((a) => a.kind))).toEqual(new Set(["deploy_safe", "transfer_erc20", "transfer_erc721", "transfer_erc1155", "transfer_native"]));

    const wallet = batchingWallet(wc, executor);
    const { state } = await execute(newMigration(plans, cfg, "fork-7702", batcher.address), wallet);
    const chain = state.chains[0]!;

    // Two wallet prompts: one type-4 transaction carrying the deployment and every token transfer,
    // then the native remainder sized from the post-batch balance.
    const log = state.log.map((l) => l.message).join("\n");
    expect(wallet.batches, log).toHaveLength(1);
    const tokenActions = plan.actions.filter((a) => a.status === "planned" && a.kind !== "transfer_native");
    expect(wallet.batches[0]).toMatchObject({ upgraded: true, calls: tokenActions.length });
    expect(wallet.sent.map((r) => r.to), log).toEqual([safeOf(plan)]);
    expect(chainOutcome(chain)).toBe("completed");
    for (const a of chain.actions) expect(a.status).toBe("verified");

    const safe = chain.safeAddress;
    const inspection = await inspectSafe(client, safe);
    expect(inspection.isSafe).toBe(true);
    expect(inspection.threshold).toBe(3);
    expect(inspection.owners).toHaveLength(5);
    expect(compareSafeToConfig(inspection, cfg, chain.contracts)).toEqual([]);

    expect(await client.readContract({ address: usd, abi: erc20Abi, functionName: "balanceOf", args: [safe] })).toBe(parseUnits("2500", 6));
    for (const id of [1n, 2n, 3n]) {
      expect(await client.readContract({ address: nft, abi: erc721Abi, functionName: "ownerOf", args: [id] })).toBe(safe);
    }
    const held = await client.readContract({ address: multi, abi: erc1155Abi, functionName: "balanceOfBatch", args: [[safe, safe, safe], [1n, 2n, 3n]] });
    expect(held).toEqual([500n, 50n, 5n]);
    expect(await client.getBalance({ address: safe })).toBeGreaterThan(parseEther("1.9"));
    expect(await client.getBalance({ address: batcher.address })).toBeLessThan(parseEther("0.05"));

    // The source is now an EIP-7702-delegated EOA, still controlled by its single key.
    const code = (await client.getCode({ address: batcher.address }))!.toLowerCase();
    expect(code).toBe(`0xef0100${executor.slice(2).toLowerCase()}`);
  }, 300_000);
});
