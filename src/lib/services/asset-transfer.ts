import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { erc1155Abi, erc20Abi, erc721Abi } from "@/lib/abis";
import type { ActionVerification, MigrationAction } from "@/lib/domain/types";
import type { CallLike } from "./gas-estimation";
import { readErc1155Balances, readErc20Balance, readErc721Owner } from "./onchain-verification";

export function buildTransferCall(action: MigrationAction, from: Address, safe: Address): CallLike {
  switch (action.kind) {
    case "transfer_native":
      return { to: safe, data: "0x", value: BigInt(action.amounts[0] ?? "0") };
    case "transfer_erc20":
      return {
        to: action.contract!,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [safe, BigInt(action.amounts[0]!)] }),
      };
    case "transfer_erc721":
      return {
        to: action.contract!,
        value: 0n,
        data: encodeFunctionData({ abi: erc721Abi, functionName: "safeTransferFrom", args: [from, safe, BigInt(action.tokenIds[0]!)] }),
      };
    case "transfer_erc1155": {
      const ids = action.tokenIds.map(BigInt);
      const amounts = action.amounts.map(BigInt);
      return {
        to: action.contract!,
        value: 0n,
        data:
          ids.length === 1
            ? encodeFunctionData({ abi: erc1155Abi, functionName: "safeTransferFrom", args: [from, safe, ids[0]!, amounts[0]!, "0x"] })
            : encodeFunctionData({ abi: erc1155Abi, functionName: "safeBatchTransferFrom", args: [from, safe, ids, amounts, "0x"] }),
      };
    }
    default:
      throw new Error(`Not a transfer action: ${action.kind}`);
  }
}

export type SimulationResult = { ok: true } | { ok: false; reason: string };

/**
 * eth_call from the source EOA. For ERC-20 we also handle tokens that return nothing (USDT-style,
 * accepted) and tokens that return `false` instead of reverting (rejected).
 */
export async function simulateTransfer(client: PublicClient, from: Address, action: MigrationAction, call: CallLike): Promise<SimulationResult> {
  try {
    const { data } = await client.call({ account: from, to: call.to, data: call.data, value: call.value });
    if (action.kind === "transfer_erc20" && data && data !== "0x") {
      try {
        const ok = decodeFunctionResult({ abi: erc20Abi, functionName: "transfer", data });
        if (!ok) return { ok: false, reason: "Token transfer returned false." };
      } catch {
        return { ok: false, reason: "Token returned unexpected data from transfer()." };
      }
    }
    return { ok: true };
  } catch (e) {
    const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
    return { ok: false, reason: `Simulation reverted: ${msg.slice(0, 200)}` };
  }
}

export interface RefreshResult {
  /** Updated amounts to move (full current balance). */
  amounts: string[];
  /** Asset already sits in the Safe (e.g. a previous session's transfer landed). */
  alreadyInSafe: boolean;
  /** Source no longer holds anything for this action. */
  nothingToMove: boolean;
}

/** Re-reads balances right before sending so retries never resend what already moved. */
export async function refreshTransferAmounts(
  client: PublicClient,
  action: MigrationAction,
  source: Address,
  safe: Address,
): Promise<RefreshResult> {
  switch (action.kind) {
    case "transfer_erc20": {
      const bal = await readErc20Balance(client, action.contract!, source);
      return { amounts: [bal.toString()], alreadyInSafe: false, nothingToMove: bal === 0n };
    }
    case "transfer_erc721": {
      const owner = await readErc721Owner(client, action.contract!, BigInt(action.tokenIds[0]!));
      const inSafe = owner?.toLowerCase() === safe.toLowerCase();
      const held = owner?.toLowerCase() === source.toLowerCase();
      return { amounts: ["1"], alreadyInSafe: inSafe, nothingToMove: !held };
    }
    case "transfer_erc1155": {
      const bals = await readErc1155Balances(client, action.contract!, source, action.tokenIds.map(BigInt));
      return { amounts: bals.map(String), alreadyInSafe: false, nothingToMove: bals.every((b) => b === 0n) };
    }
    default:
      return { amounts: action.amounts, alreadyInSafe: false, nothingToMove: false };
  }
}

/** Drops ERC-1155 ids whose current balance is zero so the batch does not revert. */
export function pruneZeroErc1155(action: MigrationAction, amounts: string[]): Pick<MigrationAction, "tokenIds" | "amounts"> {
  const keep = amounts.map((a, i) => [action.tokenIds[i]!, a] as const).filter(([, a]) => BigInt(a) > 0n);
  return { tokenIds: keep.map(([id]) => id), amounts: keep.map(([, a]) => a) };
}

export async function readSafeBalances(client: PublicClient, action: MigrationAction, safe: Address, blockNumber?: bigint): Promise<string[]> {
  switch (action.kind) {
    case "transfer_native":
      return [(await client.getBalance({ address: safe, blockNumber })).toString()];
    case "transfer_erc20":
      return [(await readErc20Balance(client, action.contract!, safe, blockNumber)).toString()];
    case "transfer_erc1155":
      return (await readErc1155Balances(client, action.contract!, safe, action.tokenIds.map(BigInt), blockNumber)).map(String);
    case "transfer_erc721": {
      const owner = await readErc721Owner(client, action.contract!, BigInt(action.tokenIds[0]!), blockNumber);
      return [owner?.toLowerCase() === safe.toLowerCase() ? "1" : "0"];
    }
    default:
      return [];
  }
}

export type VerifyOutcome = {
  status: "verified" | "verified_with_discrepancy" | "needs_attention";
  verification: ActionVerification;
};

/**
 * Compares Safe holdings after the transfer with the snapshot taken before sending.
 * A submitted or even mined transaction is NOT treated as success until this passes.
 */
export async function verifyTransfer(
  client: PublicClient,
  action: MigrationAction,
  source: Address,
  safe: Address,
  blockNumber: bigint,
): Promise<VerifyOutcome> {
  const expectedTotal = action.amounts.reduce((a, b) => a + BigInt(b), 0n);
  const after = await readSafeBalances(client, action, safe, blockNumber);
  const before = action.safeBalancesBefore ?? after.map(() => "0");
  const deltas = after.map((a, i) => BigInt(a) - BigInt(before[i] ?? "0"));
  const deltaTotal = deltas.reduce((a, b) => a + b, 0n);

  let sourceRemaining: bigint | null = null;
  try {
    if (action.kind === "transfer_erc20") sourceRemaining = await readErc20Balance(client, action.contract!, source, blockNumber);
    if (action.kind === "transfer_native") sourceRemaining = await client.getBalance({ address: source, blockNumber });
    if (action.kind === "transfer_erc1155") {
      sourceRemaining = (await readErc1155Balances(client, action.contract!, source, action.tokenIds.map(BigInt), blockNumber)).reduce(
        (a, b) => a + b,
        0n,
      );
    }
  } catch {
    sourceRemaining = null;
  }

  const base: ActionVerification = {
    expected: expectedTotal.toString(),
    safeDelta: deltaTotal.toString(),
    sourceRemaining: sourceRemaining?.toString() ?? null,
    note: null,
    blockNumber: blockNumber.toString(),
  };

  if (action.kind === "transfer_erc721") {
    const owner = await readErc721Owner(client, action.contract!, BigInt(action.tokenIds[0]!), blockNumber);
    if (owner && getAddress(owner) === getAddress(safe)) return { status: "verified", verification: { ...base, safeDelta: "1" } };
    return { status: "needs_attention", verification: { ...base, note: `NFT owner is ${owner ?? "unknown"}, not the Safe.` } };
  }

  const perIdOk = action.kind === "transfer_erc1155" ? deltas.every((d, i) => d === BigInt(action.amounts[i] ?? "0")) : true;
  if (deltaTotal === expectedTotal && perIdOk) return { status: "verified", verification: base };
  if (action.kind === "transfer_native" && deltaTotal > expectedTotal) {
    return { status: "verified", verification: { ...base, note: "Safe received additional funds from another source." } };
  }
  if (deltaTotal > 0n && deltaTotal < expectedTotal) {
    return {
      status: "verified_with_discrepancy",
      verification: {
        ...base,
        note: `Safe received ${deltaTotal} of ${expectedTotal} base units — likely a fee-on-transfer or rebasing token.`,
      },
    };
  }
  return {
    status: "needs_attention",
    verification: { ...base, note: deltaTotal === 0n ? "No balance change observed in the Safe." : "Unexpected balance change." },
  };
}

export function txHashOrNull(h: unknown): Hex | null {
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as Hex) : null;
}
