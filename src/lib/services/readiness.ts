import { decodeAbiParameters, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { findChain } from "@/lib/chains/registry";
import type { GovernanceSnapshot, OutgoingEvidence, SafeProfile } from "@/lib/domain/profile";
import { safeAbi } from "@/lib/abis";
import { governanceByChain } from "./safe-profile";

/*
 * Safe readiness: factual checks only. It reports what was OBSERVED onchain, what the user merely
 * ACKNOWLEDGED, and what is UNKNOWN, and never infers that owners are independent people, devices or
 * seed phrases from their addresses or labels.
 */

/** keccak256("ExecutionSuccess(bytes32,uint256)"), emitted by Safe v1.3.0 and v1.4.1 after `execTransaction`. */
export const EXECUTION_SUCCESS_TOPIC = keccak256(toHex("ExecutionSuccess(bytes32,uint256)"));

export type EvidenceResult = { ok: true; evidence: OutgoingEvidence } | { ok: false; reason: string };

/**
 * Accepts a transaction hash as proof that the Safe executed a threshold-signed transaction: the
 * receipt must be successful on the expected chain and contain an `ExecutionSuccess` log emitted by
 * the Safe itself (module executions emit a different event and do not count). The threshold is
 * read at the block before execution, i.e. what the Safe enforced for it. A plain transfer that
 * merely involves the Safe address is not accepted.
 */
export async function verifyOutgoingSafeTx(params: { client: PublicClient; chainId: number; safe: Address; txHash: Hex; now?: number }): Promise<EvidenceResult> {
  const { client, chainId, safe, txHash } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "Not a transaction hash." };
  try {
    if ((await client.getChainId()) !== chainId) return { ok: false, reason: "RPC is on the wrong network." };
  } catch (e) {
    return { ok: false, reason: `Network unreachable: ${(e as Error).message.slice(0, 120)}` };
  }
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: `No such transaction on ${findChain(chainId)?.name ?? chainId} (or not mined yet).` };
  }
  if (receipt.status !== "success") return { ok: false, reason: "The transaction reverted." };
  const log = receipt.logs.find((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0]?.toLowerCase() === EXECUTION_SUCCESS_TOPIC.toLowerCase());
  if (!log) return { ok: false, reason: "This transaction contains no successful execution by this Safe (an ExecutionSuccess event from the Safe). A transfer to or from the Safe is not enough." };
  let safeTxHash: Hex;
  try {
    [safeTxHash] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], log.data) as [Hex, bigint];
  } catch {
    return { ok: false, reason: "Unexpected ExecutionSuccess event format." };
  }
  let threshold: bigint;
  try {
    threshold = await client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold", blockNumber: receipt.blockNumber - 1n });
  } catch (e) {
    return { ok: false, reason: `Could not read the Safe's threshold at that block: ${(e as Error).message.slice(0, 120)}` };
  }
  return {
    ok: true,
    evidence: {
      chainId,
      txHash: txHash.toLowerCase() as Hex,
      safe,
      blockNumber: receipt.blockNumber.toString(),
      thresholdAtBlock: Number(threshold),
      safeTxHash: safeTxHash.toLowerCase() as Hex,
      verifiedAt: params.now ?? Date.now(),
    },
  };
}

export type CheckState = "observed" | "acknowledged" | "attention" | "unknown" | "missing";

export interface ReadinessItem {
  key: "deployment" | "owners" | "gas" | "outgoing";
  title: string;
  state: CheckState;
  detail: string[];
}

export interface ReadinessInput {
  profile: SafeProfile;
  /** Owners with a currently valid v2 proof (key control at signing time). */
  verifiedOwners: readonly Address[];
  /** Live native balance of the Safe per chain; null = could not be read. */
  safeNativeBalances: Readonly<Record<number, bigint | null>>;
  now?: number;
}

const fmtChain = (id: number) => findChain(id)?.name ?? String(id);

export function assessReadiness(input: ReadinessInput): ReadinessItem[] {
  const now = input.now ?? Date.now();
  const p = input.profile;
  const gov = governanceByChain(p, now);
  const deployed = gov.filter((g) => g.state !== "not_deployed");

  // 1. Deployment and security settings, per network.
  const deployment: ReadinessItem = { key: "deployment", title: "Deployed and verified onchain", state: "missing", detail: [] };
  if (deployed.length === 0) deployment.detail.push("Not deployed on any network yet.");
  for (const g of deployed) {
    const s = g.snapshot;
    if (!s) deployment.detail.push(`${fmtChain(g.chainId)}: deployed, not yet observed. Re-read governance.`);
    else if (g.state === "matches_original") deployment.detail.push(`${fmtChain(g.chainId)}: original owners and threshold, no modules or guard, official contracts (block ${s.blockNumber}${g.stale ? ", observation older than 24 h" : ""}).`);
    else deployment.detail.push(`${fmtChain(g.chainId)}: changed since deployment: ${s.issues.join(" ")}`);
  }
  if (deployed.length) {
    deployment.state = deployed.some((g) => g.state === "diverged") ? "attention" : deployed.some((g) => !g.snapshot || g.stale) ? "unknown" : "observed";
  }

  // 2. Owners whose control was proven, against each network's CURRENT threshold.
  const owners: ReadinessItem = { key: "owners", title: "Enough owners have proven key control", state: "missing", detail: [] };
  const proven = new Set(input.verifiedOwners.map((o) => o.toLowerCase()));
  const perChain = deployed.map((g) => {
    const s: GovernanceSnapshot | null = g.snapshot;
    const current = s ? s.owners : p.original.owners;
    const threshold = s ? s.threshold : p.original.threshold;
    const count = current.filter((o) => proven.has(o.toLowerCase())).length;
    return { chainId: g.chainId, count, threshold, known: !!s };
  });
  if (perChain.length === 0) {
    const count = p.original.owners.filter((o) => proven.has(o.toLowerCase())).length;
    perChain.push({ chainId: 0, count, threshold: p.original.threshold, known: true });
  }
  for (const c of perChain) owners.detail.push(`${c.chainId ? fmtChain(c.chainId) : "Configuration"}: ${c.count} of the ${c.threshold} required owner signature(s) proven${c.known ? "" : " (current owners unknown; using the original list)"}.`);
  owners.detail.push("A proof shows control of an address when it signed. It does not show that owners are different people, devices or seed phrases.");
  owners.state = perChain.every((c) => c.count >= c.threshold) ? "observed" : perChain.some((c) => c.count > 0) ? "attention" : "missing";

  // 3. Native gas in the Safe, needed to execute anything from it.
  const gas: ReadinessItem = { key: "gas", title: "Safe holds native gas", state: "missing", detail: [] };
  for (const g of deployed) {
    const bal = input.safeNativeBalances[g.chainId];
    const meta = findChain(g.chainId);
    if (bal === undefined || bal === null) gas.detail.push(`${fmtChain(g.chainId)}: balance unknown.`);
    else gas.detail.push(`${fmtChain(g.chainId)}: ${bal === 0n ? "no" : "has"} ${meta?.nativeSymbol ?? "native"} (${bal.toString()} base units).`);
  }
  const balances = deployed.map((g) => input.safeNativeBalances[g.chainId]);
  gas.state = deployed.length === 0 ? "missing" : balances.some((b) => b === undefined || b === null) ? "unknown" : balances.every((b) => (b ?? 0n) > 0n) ? "observed" : "attention";
  if (gas.state !== "observed") gas.detail.push("Owners (or a relayer) pay gas to execute Safe transactions; a Safe without native gas may need a top-up first.");

  // 4. A threshold-signed transaction actually executed by the Safe.
  const outgoing: ReadinessItem = { key: "outgoing", title: "An outgoing Safe transaction has been executed", state: "missing", detail: [] };
  for (const e of p.readiness.outgoing) outgoing.detail.push(`Observed: ${fmtChain(e.chainId)} tx ${e.txHash.slice(0, 12)}… executed by the Safe with threshold ${e.thresholdAtBlock} (block ${e.blockNumber}).`);
  if (p.readiness.outgoing.length) outgoing.state = "observed";
  else if (p.readiness.acknowledgedTestTransaction) {
    outgoing.state = "acknowledged";
    outgoing.detail.push(`You confirmed on ${new Date(p.readiness.acknowledgedTestTransaction).toLocaleDateString()} that a test transaction was executed. This app did not observe it.`);
  } else outgoing.detail.push("Not demonstrated yet. Send a small transaction from the Safe with the required owner signatures, then paste its hash here.");

  return [deployment, owners, gas, outgoing];
}

