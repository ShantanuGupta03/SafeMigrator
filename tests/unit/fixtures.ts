import { getAddress, type Address } from "viem";
import type { DiscoveredAsset, SafeContractSet, SignerSlot } from "@/lib/domain/types";
import { canonicalContracts } from "@/lib/services/safe-deployment";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";

export const SEPOLIA = 11155111;
export const CHIADO = 10200;

export const SOURCE = getAddress("0x00000000000000000000000000000000000000a1");
export const OWNER_B = getAddress("0x00000000000000000000000000000000000000b2");
export const OWNER_C = getAddress("0x00000000000000000000000000000000000000c3");
export const SAFE = getAddress("0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe");
export const TOKEN = getAddress("0x7070707070707070707070707070707070707070");
export const NFT = getAddress("0x8080808080808080808080808080808080808080");

export const CONFIG = buildSafeConfig([OWNER_C, SOURCE, OWNER_B], 2, deriveSaltNonce(SOURCE));

export function contracts130(): SafeContractSet {
  const c = canonicalContracts("1.3.0");
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.address])) as unknown as SafeContractSet;
}

export function asset(partial: Partial<DiscoveredAsset> & Pick<DiscoveredAsset, "standard">): DiscoveredAsset {
  const chainId = partial.chainId ?? SEPOLIA;
  const contract = partial.contract ?? (partial.standard === "native" ? null : TOKEN);
  return {
    id: `${chainId}:${partial.standard}:${contract?.toLowerCase() ?? "native"}${partial.tokenId ? `:${partial.tokenId}` : ""}`,
    chainId,
    contract,
    tokenId: null,
    name: "Token",
    symbol: "TKN",
    decimals: partial.standard === "native" ? 18 : 6,
    balance: "1000000",
    usdValue: null,
    imageUrl: null,
    classification: "transferable",
    flags: [],
    reasons: [],
    sources: ["rpc"],
    verifiedOnchain: true,
    ...partial,
  };
}

export function slot(i: number, address: Address | null, input = address ?? ""): SignerSlot {
  return { slot: i, input, address, ensName: null, kind: "independent_wallet", label: `Signer ${i + 1}`, verification: null };
}

/** A finished two-network run with a deployment, transfers, a discrepancy and a blocked network. */
export function sampleMigration(overrides: Partial<import("@/lib/domain/types").Migration> = {}): import("@/lib/domain/types").Migration {
  const c = contracts130();
  const action = (p: Partial<import("@/lib/domain/types").MigrationAction> & Pick<import("@/lib/domain/types").MigrationAction, "id" | "kind" | "label">): import("@/lib/domain/types").MigrationAction => ({
    chainId: SEPOLIA,
    assetIds: [],
    contract: null,
    tokenIds: [],
    amounts: [],
    decimals: 18,
    symbol: "",
    status: "verified",
    txHash: null,
    callsId: null,
    txNonce: null,
    submittedAt: 1,
    safeBalancesBefore: null,
    gasLimit: null,
    feeEstimate: null,
    feePaid: "21000000000000",
    verification: null,
    error: null,
    attempts: 1,
    ...p,
  });
  const inspection = { address: SAFE, hasCode: true, isSafe: true, owners: CONFIG.owners, threshold: 2, version: "1.3.0", singleton: c.singleton, fallbackHandler: c.fallbackHandler, guard: null, modules: [], nonce: "0", blockNumber: "120", blockHash: `0x${"cd".repeat(32)}` as `0x${string}` };
  return {
    id: "run-0001",
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    source: SOURCE,
    environment: "testnet",
    safeConfig: CONFIG,
    verifiedOwners: [],
    ownerProofs: [],
    profileId: "11111111-2222-3333-4444-555555555555",
    deploymentCommitment: `0x${"ab".repeat(32)}`,
    purpose: "migration",
    runState: "finished",
    log: [{ at: 1, chainId: null, actionId: null, level: "info", message: "internal debug line" }],
    scope: {
      selectedChainIds: [SEPOLIA, CHIADO],
      selectedAssets: [],
      includedChainIds: [SEPOLIA],
      blockedChains: [{ chainId: CHIADO, reasons: ["Insufficient xDAI for gas on Gnosis Chiado."], assetIds: [] }],
      excludedAssets: [{ assetId: `${SEPOLIA}:erc20:${TOKEN.toLowerCase()}`, chainId: SEPOLIA, label: "RST", amount: "5", decimals: 18, reason: "Simulation reverted: restricted" }],
      partialAcknowledged: true,
      incompleteDiscovery: [],
      plannedAt: 1_700_000_000_000,
    },
    chains: [
      {
        chainId: SEPOLIA,
        safeAddress: SAFE,
        safeVersion: "1.3.0",
        contracts: c,
        strategy: "sequential",
        phase: "completed",
        message: null,
        batches: [],
        safeVerification: inspection,
        actions: [
          action({ id: `${SEPOLIA}:deploy_safe`, kind: "deploy_safe", label: "Deploy Safe on Sepolia", txHash: `0x${"01".repeat(32)}` }),
          action({
            id: `${SEPOLIA}:transfer_erc20:${TOKEN.toLowerCase()}`,
            kind: "transfer_erc20",
            label: "Transfer FEE",
            contract: TOKEN,
            amounts: ["1000000"],
            previewAmounts: ["1000000"],
            decimals: 6,
            symbol: "FEE",
            status: "verified_with_discrepancy",
            txHash: `0x${"02".repeat(32)}`,
            verification: { expected: "1000000", safeDelta: "990000", sourceRemaining: "0", note: "Received 1% less (fee-on-transfer).", blockNumber: "121", loggedAmount: "990000", evidence: "receipt_logs" },
          }),
          action({ id: `${SEPOLIA}:transfer_native`, kind: "transfer_native", label: "Transfer ETH", amounts: ["500000000000000000"], symbol: "ETH", txHash: `0x${"03".repeat(32)}`, verification: { expected: "500000000000000000", safeDelta: "500000000000000000", sourceRemaining: "1000", note: null, blockNumber: "122", evidence: "balance_only" } }),
        ],
      },
    ],
    ...overrides,
  };
}
