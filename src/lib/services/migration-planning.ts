import type { Address, PublicClient } from "viem";
import { executionGate, getChain, type ExecutionGate } from "@/lib/chains/registry";
import { appConfig } from "@/lib/config";
import { formatAmount, sumBigInt } from "@/lib/domain/amounts";
import type {
  ChainMigration,
  ChainSafeTarget,
  DiscoveredAsset,
  ExecutionStrategy,
  Migration,
  MigrationAction,
  MigrationScope,
  OwnerProof,
  SafeConfig,
  SafeContractSet,
  SupportedSafeVersion,
} from "@/lib/domain/types";
import { buildTransferCall, simulateTransfer, type SimulationResult } from "./asset-transfer";
import {
  estimateCallGas,
  estimateL1DataFee,
  FALLBACK_GAS,
  getFeeQuote,
  isDust,
  maxCost,
  spendableNative,
  typicalCost,
  type FeeQuote,
} from "./gas-estimation";
import { buildDeploymentTransaction } from "./safe-deployment";
import { strategyFor, type ChainCapability } from "./transaction-capability";

/* ------------------------------ Action builder ----------------------------- */

export function actionId(chainId: number, kind: MigrationAction["kind"], contract?: string | null, tokenIds: string[] = []): string {
  const parts = [String(chainId), kind];
  if (contract) parts.push(contract.toLowerCase());
  if (tokenIds.length) parts.push(tokenIds.join(","));
  return parts.join(":");
}

function baseAction(partial: Pick<MigrationAction, "id" | "chainId" | "kind" | "label"> & Partial<MigrationAction>): MigrationAction {
  return {
    assetIds: [],
    contract: null,
    tokenIds: [],
    amounts: [],
    decimals: 0,
    symbol: "",
    status: "planned",
    txHash: null,
    callsId: null,
    txNonce: null,
    submittedAt: null,
    safeBalancesBefore: null,
    gasLimit: null,
    feeEstimate: null,
    feePaid: null,
    verification: null,
    error: null,
    attempts: 0,
    ...partial,
  };
}

/**
 * Deterministic ordering: deploy → ERC-20 → ERC-721 → ERC-1155 (grouped per contract) → native last,
 * so native gas stays available for every other step.
 */
export function buildActions(chainId: number, assets: readonly DiscoveredAsset[], needsDeployment: boolean): MigrationAction[] {
  const chain = getChain(chainId);
  const onChain = assets.filter((a) => a.chainId === chainId);
  const out: MigrationAction[] = [];
  out.push(
    baseAction({
      id: actionId(chainId, "deploy_safe"),
      chainId,
      kind: "deploy_safe",
      label: `Deploy Safe on ${chain.name}`,
      status: needsDeployment ? "planned" : "skipped",
      verification: needsDeployment
        ? null
        : { expected: "0", safeDelta: null, sourceRemaining: null, note: "Safe already deployed with the expected configuration.", blockNumber: null },
    }),
  );
  const sortById = (a: DiscoveredAsset, b: DiscoveredAsset) => a.id.localeCompare(b.id);
  for (const a of onChain.filter((x) => x.standard === "erc20").sort(sortById)) {
    out.push(
      baseAction({
        id: actionId(chainId, "transfer_erc20", a.contract),
        chainId,
        kind: "transfer_erc20",
        label: `Transfer ${a.symbol}`,
        assetIds: [a.id],
        contract: a.contract,
        amounts: [a.balance],
        decimals: a.decimals,
        symbol: a.symbol,
      }),
    );
  }
  for (const a of onChain.filter((x) => x.standard === "erc721").sort(sortById)) {
    out.push(
      baseAction({
        id: actionId(chainId, "transfer_erc721", a.contract, [a.tokenId!]),
        chainId,
        kind: "transfer_erc721",
        label: `Transfer ${a.name} #${a.tokenId}`,
        assetIds: [a.id],
        contract: a.contract,
        tokenIds: [a.tokenId!],
        amounts: ["1"],
        symbol: a.symbol,
      }),
    );
  }
  const by1155 = new Map<string, DiscoveredAsset[]>();
  for (const a of onChain.filter((x) => x.standard === "erc1155")) {
    const k = a.contract!.toLowerCase();
    by1155.set(k, [...(by1155.get(k) ?? []), a]);
  }
  for (const [, group] of [...by1155.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((x, y) => (BigInt(x.tokenId!) < BigInt(y.tokenId!) ? -1 : 1));
    const ids = sorted.map((g) => g.tokenId!);
    out.push(
      baseAction({
        id: actionId(chainId, "transfer_erc1155", sorted[0]!.contract, ids),
        chainId,
        kind: "transfer_erc1155",
        label: `Transfer ${sorted[0]!.name} (${ids.length} id${ids.length > 1 ? "s" : ""})`,
        assetIds: sorted.map((g) => g.id),
        contract: sorted[0]!.contract,
        tokenIds: ids,
        amounts: sorted.map((g) => g.balance),
        symbol: sorted[0]!.symbol,
      }),
    );
  }
  const native = onChain.find((x) => x.standard === "native");
  if (native) {
    out.push(
      baseAction({
        id: actionId(chainId, "transfer_native"),
        chainId,
        kind: "transfer_native",
        label: `Transfer ${chain.nativeSymbol}`,
        assetIds: [native.id],
        amounts: [native.balance],
        decimals: chain.nativeDecimals,
        symbol: chain.nativeSymbol,
      }),
    );
  }
  return out;
}

/* -------------------------------- Preflight -------------------------------- */

export interface ActionEstimate {
  gasLimit: bigint;
  l1Fee: bigint;
  /** True when the estimate is a fixed assumption because the Safe isn't deployed yet. */
  assumed: boolean;
}

export interface ChainPreflight {
  chainId: number;
  target: ChainSafeTarget;
  nativeBalance: bigint | null;
  fee: FeeQuote | null;
  estimates: Record<string, ActionEstimate>;
  simulations: Record<string, SimulationResult>;
  capability: ChainCapability | undefined;
  gate: ExecutionGate;
  pendingTransactions: number;
  errors: string[];
}

export async function preflightChain(params: {
  client: PublicClient;
  source: Address;
  config: SafeConfig;
  target: ChainSafeTarget;
  actions: MigrationAction[];
  capability: ChainCapability | undefined;
}): Promise<ChainPreflight> {
  const { client, source, config, target, actions, capability } = params;
  const chainId = target.chainId;
  const pre: ChainPreflight = {
    chainId,
    target,
    nativeBalance: null,
    fee: null,
    estimates: {},
    simulations: {},
    capability,
    gate: executionGate(chainId),
    pendingTransactions: 0,
    errors: [],
  };
  if (!target.predictedAddress || !target.safeVersion || !target.contracts) return pre;
  const safe = target.predictedAddress;
  const safeDeployed = target.status === "deployed_matching";

  try {
    const [balance, fee, latestNonce, pendingNonce] = await Promise.all([
      client.getBalance({ address: source }),
      getFeeQuote(client),
      client.getTransactionCount({ address: source, blockTag: "latest" }),
      client.getTransactionCount({ address: source, blockTag: "pending" }),
    ]);
    pre.nativeBalance = balance;
    pre.fee = fee;
    pre.pendingTransactions = Math.max(0, pendingNonce - latestNonce);
  } catch (e) {
    pre.errors.push(`Could not read balance or fees: ${(e as Error).message.slice(0, 140)}`);
    return pre;
  }

  for (const action of actions) {
    if (action.status !== "planned") continue;
    try {
      if (action.kind === "deploy_safe") {
        const tx = await buildDeploymentTransaction(chainId, client, config, target.safeVersion, target.contracts);
        const gasLimit = await estimateCallGas(client, source, tx);
        pre.estimates[action.id] = { gasLimit, l1Fee: await estimateL1DataFee(client, chainId, source, tx), assumed: false };
        pre.simulations[action.id] = { ok: true };
        continue;
      }
      if (action.kind === "transfer_native") {
        const call = { to: safe, data: "0x" as const, value: 1n };
        const gasLimit = safeDeployed ? await estimateCallGas(client, source, call) : FALLBACK_GAS.nativeToSafe;
        pre.estimates[action.id] = {
          gasLimit,
          l1Fee: await estimateL1DataFee(client, chainId, source, call),
          assumed: !safeDeployed,
        };
        pre.simulations[action.id] = { ok: true };
        continue;
      }
      const call = buildTransferCall(action, source, safe);
      const sim = await simulateTransfer(client, source, action, call);
      pre.simulations[action.id] = sim;
      if (!sim.ok) continue;
      let gasLimit = await estimateCallGas(client, source, call);
      // Before deployment the receiver hooks (onERC721Received / onERC1155Received) are not exercised.
      if (!safeDeployed && action.kind === "transfer_erc721") gasLimit += FALLBACK_GAS.erc721ToSafeOverhead;
      if (!safeDeployed && action.kind === "transfer_erc1155") gasLimit += FALLBACK_GAS.erc1155ToSafeOverhead;
      pre.estimates[action.id] = {
        gasLimit,
        l1Fee: await estimateL1DataFee(client, chainId, source, call),
        assumed: !safeDeployed && action.kind !== "transfer_erc20",
      };
    } catch (e) {
      pre.simulations[action.id] = { ok: false, reason: `Estimation failed: ${(e as Error).message.slice(0, 160)}` };
    }
  }
  return pre;
}

/* -------------------------------- Assembly -------------------------------- */

export interface ConfirmationCount {
  chainSwitch: number;
  deployment: number;
  transfers: number;
  total: number;
  /** The Safe deployment rides in the same atomic batch as the transfers (no separate prompt). */
  deploymentInBatch: boolean;
  note: string | null;
}

export interface ChainPlan {
  chainId: number;
  safeAddress: Address | null;
  safeVersion: SupportedSafeVersion | null;
  contracts: SafeContractSet | null;
  needsDeployment: boolean;
  strategy: ExecutionStrategy;
  actions: MigrationAction[];
  excluded: { action: MigrationAction; reason: string }[];
  costs: { deployMax: bigint; transfersMax: bigint; totalMax: bigint; totalTypical: bigint };
  nativeBalance: bigint | null;
  nativeReserve: bigint;
  nativeToSend: bigint | null;
  deficit: bigint;
  confirmations: ConfirmationCount;
  blockers: string[];
  warnings: string[];
  executable: boolean;
}

export function assembleChainPlan(
  pre: ChainPreflight,
  actions: MigrationAction[],
  opts: { verifiedOwnerCount: number; threshold: number; strategyOverride?: ExecutionStrategy; walletChainId?: number; dustMultiple?: number },
): ChainPlan {
  const chain = getChain(pre.chainId);
  const blockers: string[] = [];
  const warnings: string[] = [...pre.errors];
  const t = pre.target;

  if (!pre.gate.enabled) blockers.push(pre.gate.reason ?? "Execution disabled.");
  if (pre.gate.requiresVerifiedOwners && opts.verifiedOwnerCount < opts.threshold) {
    blockers.push(`Production networks require ${opts.threshold} owners verified by signature (${opts.verifiedOwnerCount} verified).`);
  }
  if (t.status === "incompatible") blockers.push(`No compatible Safe deployment: ${t.issues.join(" ")}`);
  if (t.status === "error") blockers.push(`Safe address could not be verified: ${t.issues.join(" ")}`);
  if (t.status === "deployed_mismatch") {
    blockers.push(`A contract already exists at the predicted address with a different configuration: ${t.issues.join(" ")}`);
  }
  if (pre.pendingTransactions > 0) {
    blockers.push(`${pre.pendingTransactions} pending transaction(s) from your wallet on ${chain.name}. Wait for them to confirm to avoid nonce conflicts.`);
  }
  if (!pre.fee || pre.nativeBalance === null) blockers.push(`Fee data or balance unavailable on ${chain.name}.`);

  const included: MigrationAction[] = [];
  const excluded: ChainPlan["excluded"] = [];
  for (const a of actions) {
    if (a.status !== "planned") {
      included.push(a);
      continue;
    }
    const sim = pre.simulations[a.id];
    if (sim && !sim.ok) {
      excluded.push({ action: a, reason: sim.reason });
      continue;
    }
    included.push(a);
  }

  const fee = pre.fee;
  const costOf = (a: MigrationAction) => {
    const e = pre.estimates[a.id];
    return e && fee ? maxCost(e.gasLimit, fee, e.l1Fee) : 0n;
  };
  const typicalOf = (a: MigrationAction) => {
    const e = pre.estimates[a.id];
    return e && fee ? typicalCost(e.gasLimit, fee, e.l1Fee) : 0n;
  };
  const planned = included.filter((a) => a.status === "planned");
  const deploy = planned.find((a) => a.kind === "deploy_safe");
  const native = planned.find((a) => a.kind === "transfer_native");
  const others = planned.filter((a) => a.kind !== "deploy_safe" && a.kind !== "transfer_native");

  const deployMax = deploy ? costOf(deploy) : 0n;
  const othersMax = sumBigInt(others.map(costOf));
  const nativeFeeMax = native ? costOf(native) : 0n;
  const reserve = deployMax + othersMax + nativeFeeMax;
  const totalTypical = sumBigInt(planned.map(typicalOf));

  let nativeToSend: bigint | null = null;
  let deficit = 0n;
  const finalActions = included.map((a) => {
    const e = pre.estimates[a.id];
    return e && fee ? { ...a, gasLimit: e.gasLimit.toString(), feeEstimate: costOf(a).toString() } : a;
  });

  if (pre.nativeBalance !== null && fee) {
    const required = deployMax + othersMax + (native ? nativeFeeMax : 0n);
    const requiredWithoutNativeTransfer = deployMax + othersMax;
    if (pre.nativeBalance < requiredWithoutNativeTransfer) {
      deficit = requiredWithoutNativeTransfer - pre.nativeBalance;
      blockers.push(
        `Insufficient ${chain.nativeSymbol} for gas on ${chain.name}: need up to ${formatAmount(requiredWithoutNativeTransfer, chain.nativeDecimals)} ` +
          `but have ${formatAmount(pre.nativeBalance, chain.nativeDecimals)}. Top up at least ${formatAmount(deficit, chain.nativeDecimals)} ${chain.nativeSymbol} and re-check.`,
      );
    }
    if (native) {
      nativeToSend = spendableNative(pre.nativeBalance, required);
      const idx = finalActions.findIndex((a) => a.id === native.id);
      if (isDust(nativeToSend, nativeFeeMax, opts.dustMultiple ?? appConfig.dustFeeMultiple)) {
        warnings.push(
          `Remaining ${chain.nativeSymbol} after gas (${formatAmount(nativeToSend, chain.nativeDecimals)}) is too small to be worth a transfer; it will stay in your wallet.`,
        );
        finalActions[idx] = {
          ...finalActions[idx]!,
          status: "skipped",
          amounts: ["0"],
          verification: { expected: "0", safeDelta: null, sourceRemaining: null, note: "Skipped: dust after gas reserve.", blockNumber: null },
        };
      } else {
        finalActions[idx] = { ...finalActions[idx]!, amounts: [nativeToSend.toString()] };
      }
    }
  }

  const strategy = opts.strategyOverride ?? strategyFor(pre.capability);
  const transferCount = finalActions.filter((a) => a.status === "planned" && a.kind !== "deploy_safe").length;
  const nativeCount = finalActions.some((a) => a.status === "planned" && a.kind === "transfer_native") ? 1 : 0;
  const tokenCount = transferCount - nativeCount;
  const deployCount = finalActions.some((a) => a.kind === "deploy_safe" && a.status === "planned") ? 1 : 0;
  // Atomic: one batch for all token transfers, then the native remainder as its own transaction.
  const transferConfirmations = strategy === "atomic_batch" ? (tokenCount > 0 ? 1 : 0) + nativeCount : transferCount;
  const deploymentInBatch = strategy === "atomic_batch" && deployCount === 1 && tokenCount > 0;
  const deploymentConfirmations = deploymentInBatch ? 0 : deployCount;
  const chainSwitch = opts.walletChainId === pre.chainId ? 0 : deploymentConfirmations + transferConfirmations > 0 ? 1 : 0;
  const note =
    strategy === "atomic_batch" && pre.capability?.atomic === "ready"
      ? "Your wallet may ask for a one-time account upgrade before the batch."
      : null;

  if (strategy === "sequential" && transferCount > 10) {
    warnings.push(`${transferCount} separate transfers on ${chain.name}: your wallet will ask you to approve each one. Deselect assets you do not need to move.`);
  }
  if (t.issues.length && t.status === "not_deployed") warnings.push(...t.issues);
  for (const a of finalActions) {
    if (pre.estimates[a.id]?.assumed) {
      warnings.push(`${a.label}: gas uses a conservative assumption until the Safe is deployed; it is re-estimated before sending.`);
    }
  }

  return {
    chainId: pre.chainId,
    safeAddress: t.predictedAddress,
    safeVersion: t.safeVersion,
    contracts: t.contracts,
    needsDeployment: deployCount === 1,
    strategy,
    actions: finalActions,
    excluded,
    costs: { deployMax, transfersMax: othersMax + nativeFeeMax, totalMax: reserve, totalTypical },
    nativeBalance: pre.nativeBalance,
    nativeReserve: reserve,
    nativeToSend,
    deficit,
    confirmations: {
      chainSwitch,
      deployment: deploymentConfirmations,
      transfers: transferConfirmations,
      total: chainSwitch + deploymentConfirmations + transferConfirmations,
      deploymentInBatch,
      note,
    },
    blockers,
    warnings,
    executable: blockers.length === 0 && finalActions.some((a) => a.status === "planned"),
  };
}

function withPreviewAmounts(actions: MigrationAction[]): MigrationAction[] {
  return actions.map((a) => ({
    ...a,
    previewAmounts: a.previewAmounts ?? [...a.amounts],
    previewTokenIds: a.previewTokenIds ?? [...a.tokenIds],
  }));
}

export function createMigration(params: {
  id: string;
  source: Address;
  environment: Migration["environment"];
  safeConfig: SafeConfig;
  verifiedOwners: Address[];
  ownerProofs?: OwnerProof[];
  ownerVerificationWaived?: boolean;
  scope?: MigrationScope | null;
  plans: ChainPlan[];
}): Migration {
  const chains: ChainMigration[] = params.plans
    .filter((p) => p.executable && p.safeAddress && p.safeVersion && p.contracts)
    .map((p) => ({
      chainId: p.chainId,
      safeAddress: p.safeAddress!,
      safeVersion: p.safeVersion!,
      contracts: p.contracts!,
      strategy: p.strategy,
      phase: "idle",
      message: null,
      actions: withPreviewAmounts(p.actions),
      batches: [],
      safeVerification: null,
    }));
  const now = Date.now();
  return {
    id: params.id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    source: params.source,
    environment: params.environment,
    safeConfig: params.safeConfig,
    verifiedOwners: params.verifiedOwners,
    ownerProofs: params.ownerProofs,
    ownerVerificationWaived: params.ownerVerificationWaived,
    scope: params.scope ?? null,
    chains,
    runState: "idle",
    log: [],
  };
}
