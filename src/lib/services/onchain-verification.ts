import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  erc1155Abi,
  erc20Abi,
  erc721Abi,
  FALLBACK_HANDLER_STORAGE_SLOT,
  GUARD_STORAGE_SLOT,
  safeAbi,
  SENTINEL_ADDRESS,
} from "@/lib/abis";
import type { ExpectedGovernance, SafeConfig, SafeContractSet, SafeInspection } from "@/lib/domain/types";

function slotToAddress(slot: Hex | undefined): Address | null {
  if (!slot || slot === "0x") return null;
  const hex = slot.slice(-40).padStart(40, "0");
  return getAddress(`0x${hex}`);
}

/** Reads the actual Safe configuration from chain. Never trusts local state. */
export async function inspectSafe(client: PublicClient, address: Address, blockNumber?: bigint): Promise<SafeInspection> {
  const block = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const code = await client.getCode({ address, blockNumber: block });
  const base: SafeInspection = {
    address,
    hasCode: !!code && code !== "0x",
    isSafe: false,
    owners: [],
    threshold: 0,
    version: null,
    singleton: null,
    fallbackHandler: null,
    guard: null,
    modules: [],
    nonce: null,
    blockNumber: block.toString(),
    blockHash: await client
      .getBlock({ blockNumber: block })
      .then((b) => b.hash ?? null)
      .catch(() => null),
  };
  if (!base.hasCode) return base;

  const read = <T>(functionName: "getOwners" | "getThreshold" | "VERSION" | "nonce") =>
    client.readContract({ address, abi: safeAbi, functionName, blockNumber: block }) as Promise<T>;

  try {
    const [owners, threshold, version, nonce, modulesPage, slot0, fallbackSlot, guardSlot] = await Promise.all([
      read<readonly Address[]>("getOwners"),
      read<bigint>("getThreshold"),
      read<string>("VERSION"),
      read<bigint>("nonce"),
      client.readContract({
        address,
        abi: safeAbi,
        functionName: "getModulesPaginated",
        args: [SENTINEL_ADDRESS, 10n],
        blockNumber: block,
      }),
      client.getStorageAt({ address, slot: "0x0", blockNumber: block }),
      client.getStorageAt({ address, slot: FALLBACK_HANDLER_STORAGE_SLOT, blockNumber: block }),
      client.getStorageAt({ address, slot: GUARD_STORAGE_SLOT, blockNumber: block }),
    ]);
    return {
      ...base,
      isSafe: true,
      owners: owners.map((o) => getAddress(o)),
      threshold: Number(threshold),
      version,
      nonce: nonce.toString(),
      modules: modulesPage[0].map((m) => getAddress(m)),
      singleton: slotToAddress(slot0),
      fallbackHandler: slotToAddress(fallbackSlot),
      guard: slotToAddress(guardSlot),
    };
  } catch {
    // Code exists but does not behave like a Safe.
    return base;
  }
}

/** Returns a list of human-readable mismatches. Empty list == verified. */
export function compareSafeToConfig(
  inspection: SafeInspection,
  config: SafeConfig,
  contracts: SafeContractSet,
): string[] {
  const issues: string[] = [];
  if (!inspection.hasCode) return ["No contract code at the Safe address."];
  if (!inspection.isSafe) return ["A contract exists at this address but it is not a Safe. It will not be used."];
  const want = new Set(config.owners.map((o) => o.toLowerCase()));
  const have = new Set(inspection.owners.map((o) => o.toLowerCase()));
  const sameOwners = want.size === have.size && [...want].every((o) => have.has(o));
  if (!sameOwners) issues.push(`Owners differ: onchain ${inspection.owners.join(", ")}.`);
  if (inspection.threshold !== config.threshold) {
    issues.push(`Threshold is ${inspection.threshold}, expected ${config.threshold}.`);
  }
  if (!inspection.singleton || inspection.singleton.toLowerCase() !== contracts.singleton.toLowerCase()) {
    issues.push(`Unexpected singleton ${inspection.singleton ?? "none"}.`);
  }
  if (inspection.modules.length > 0) issues.push(`Modules enabled: ${inspection.modules.join(", ")}.`);
  if (inspection.guard && inspection.guard !== zeroAddress) issues.push(`Guard set: ${inspection.guard}.`);
  if (!inspection.fallbackHandler || inspection.fallbackHandler.toLowerCase() !== contracts.fallbackHandler.toLowerCase()) {
    issues.push(`Unexpected fallback handler ${inspection.fallbackHandler ?? "none"}.`);
  }
  return issues;
}

/**
 * Compares a live Safe with governance the user reviewed (an existing Safe whose owners or settings
 * changed after deployment). Every field must still be exactly what was reviewed.
 */
export function compareSafeToGovernance(inspection: SafeInspection, expected: ExpectedGovernance): string[] {
  if (!inspection.hasCode) return ["No contract code at the Safe address."];
  if (!inspection.isSafe) return ["A contract exists at this address but it is not a Safe."];
  const issues: string[] = [];
  const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase()).sort().join(",");
  const same = (a: string | null, b: string | null) => (a ?? zeroAddress).toLowerCase() === (b ?? zeroAddress).toLowerCase();
  if (lower(inspection.owners) !== lower(expected.owners)) issues.push(`Owners changed since review: onchain ${inspection.owners.join(", ")}.`);
  if (inspection.threshold !== expected.threshold) issues.push(`Threshold is ${inspection.threshold}, reviewed ${expected.threshold}.`);
  if (!same(inspection.singleton, expected.singleton)) issues.push(`Singleton changed since review: ${inspection.singleton ?? "none"}.`);
  if (!same(inspection.fallbackHandler, expected.fallbackHandler)) issues.push(`Fallback handler changed since review: ${inspection.fallbackHandler ?? "none"}.`);
  if (!same(inspection.guard, expected.guard)) issues.push(`Guard changed since review: ${inspection.guard ?? "none"}.`);
  if (lower(inspection.modules) !== lower(expected.modules)) issues.push(`Modules changed since review: ${inspection.modules.join(", ") || "none"}.`);
  return issues;
}

/* ------------------------------ Asset reads ------------------------------ */

export async function readNativeBalance(client: PublicClient, address: Address, blockNumber?: bigint) {
  return client.getBalance({ address, blockNumber });
}

export async function readErc20Balance(client: PublicClient, token: Address, holder: Address, blockNumber?: bigint) {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber });
}

export async function readErc721Owner(client: PublicClient, token: Address, tokenId: bigint, blockNumber?: bigint) {
  try {
    const owner = await client.readContract({
      address: token,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber,
    });
    return getAddress(owner);
  } catch {
    return null;
  }
}

export async function readErc1155Balances(
  client: PublicClient,
  token: Address,
  holder: Address,
  ids: readonly bigint[],
  blockNumber?: bigint,
): Promise<bigint[]> {
  return Promise.all(
    ids.map((id) =>
      client.readContract({ address: token, abi: erc1155Abi, functionName: "balanceOf", args: [holder, id], blockNumber }),
    ),
  );
}
