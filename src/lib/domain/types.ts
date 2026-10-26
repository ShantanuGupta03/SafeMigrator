import type { Address, Hex } from "viem";

/** All onchain amounts are serialized as base-10 strings of base units (BigInt-safe). */
export type BigIntString = string;

export type Environment = "testnet" | "mainnet";

export type SupportedSafeVersion = "1.4.1" | "1.3.0";

/* -------------------------------------------------------------------------- */
/*                                   Assets                                   */
/* -------------------------------------------------------------------------- */

export type AssetStandard = "native" | "erc20" | "erc721" | "erc1155";

export type AssetClassification =
  /** Can be moved with a standard transfer adapter. */
  | "transferable"
  /** A protocol position (lending, staking, LP, vesting) — moving it needs protocol-specific handling. */
  | "specialized"
  /** Transfer simulation reverted or the token is account-bound. */
  | "non_transferable"
  /** Standard or network not supported by V1 adapters. */
  | "unsupported"
  /** Spam / impersonation heuristics matched. Never auto-selected. */
  | "suspicious";

export type AssetFlag =
  | "indexer_spam"
  | "impersonation"
  | "spam_pattern"
  | "non_ascii_symbol"
  | "rebasing"
  | "fee_on_transfer_risk"
  | "protocol_position"
  | "unverified_metadata"
  | "transfer_simulation_failed"
  | "zero_price_data";

export type AssetSource = "indexer" | "known_list" | "manual" | "rpc";

export interface DiscoveredAsset {
  /** Deterministic: `${chainId}:${standard}:${contract|native}[:${tokenId}]` */
  id: string;
  chainId: number;
  standard: AssetStandard;
  contract: Address | null;
  tokenId: BigIntString | null;
  name: string;
  symbol: string;
  decimals: number;
  /** Onchain-verified balance in base units. */
  balance: BigIntString;
  /** Approximate USD value of the full balance, only when a pricing source exists. */
  usdValue: number | null;
  imageUrl: string | null;
  classification: AssetClassification;
  flags: AssetFlag[];
  reasons: string[];
  sources: AssetSource[];
  verifiedOnchain: boolean;
}

export type CoverageLevel = "indexed" | "known_list_only" | "manual_only" | "unavailable";

export interface NetworkCoverage {
  native: boolean;
  erc20: CoverageLevel;
  erc721: CoverageLevel;
  erc1155: CoverageLevel;
  /** True when the indexer had more pages than we fetched. */
  truncated: boolean;
}

export interface NetworkDiscovery {
  chainId: number;
  status: "ok" | "partial" | "error";
  nativeBalance: BigIntString | null;
  assets: DiscoveredAsset[];
  errors: string[];
  indexer: string | null;
  coverage: NetworkCoverage;
  /** Count of indexer candidates dropped because the verified onchain balance was zero. */
  droppedZeroBalance: number;
  scannedAt: number;
}

/* -------------------------------------------------------------------------- */
/*                                   Signers                                  */
/* -------------------------------------------------------------------------- */

export type SignerKind = "connected_eoa" | "hardware" | "independent_wallet" | "other";

export interface OwnerVerification {
  method: "eip712";
  signature: Hex;
  nonce: Hex;
  issuedAt: number;
  configHash: Hex;
  verifiedAt: number;
  /** Signature verified as plain ECDSA (EOA) or via ERC-1271/6492 (contract wallet). */
  signerType: "eoa" | "contract";
  /** Chain used for ERC-1271 verification. */
  chainId: number;
}

export interface SignerSlot {
  /** Zero-based position; also the display order ("Signer slot+1"). */
  slot: number;
  input: string;
  address: Address | null;
  ensName: string | null;
  kind: SignerKind;
  label: string;
  verification: OwnerVerification | null;
}

/* -------------------------------------------------------------------------- */
/*                                Safe config                                 */
/* -------------------------------------------------------------------------- */

export interface SafeContractSet {
  singleton: Address;
  proxyFactory: Address;
  fallbackHandler: Address;
  multiSend: Address;
  multiSendCallOnly: Address;
  signMessageLib: Address;
  createCall: Address;
  simulateTxAccessor: Address;
}

export interface SafeConfig {
  /** Checksummed, unique, sorted ascending. */
  owners: Address[];
  threshold: number;
  saltNonce: BigIntString;
}

export interface SafeInspection {
  address: Address;
  hasCode: boolean;
  isSafe: boolean;
  owners: Address[];
  threshold: number;
  version: string | null;
  singleton: Address | null;
  fallbackHandler: Address | null;
  guard: Address | null;
  modules: Address[];
  nonce: BigIntString | null;
  blockNumber: BigIntString;
}

export type SafeTargetStatus =
  | "not_deployed"
  | "deployed_matching"
  | "deployed_mismatch"
  | "incompatible"
  | "error";

export interface ChainSafeTarget {
  chainId: number;
  safeVersion: SupportedSafeVersion | null;
  contracts: SafeContractSet | null;
  predictedAddress: Address | null;
  status: SafeTargetStatus;
  inspection: SafeInspection | null;
  issues: string[];
}

/* -------------------------------------------------------------------------- */
/*                                 Execution                                  */
/* -------------------------------------------------------------------------- */

export type ActionKind =
  | "deploy_safe"
  | "transfer_native"
  | "transfer_erc20"
  | "transfer_erc721"
  | "transfer_erc1155";

export type ActionStatus =
  | "planned"
  | "awaiting_wallet"
  | "submitted"
  | "verifying"
  | "verified"
  | "verified_with_discrepancy"
  | "skipped"
  | "rejected"
  | "failed"
  | "needs_attention";

export interface ActionError {
  code:
    | "user_rejected"
    | "insufficient_gas"
    | "simulation_failed"
    | "reverted"
    | "rpc_error"
    | "wrong_chain"
    | "wrong_account"
    | "verification_failed"
    | "pending_transaction"
    | "batch_failed"
    | "dropped"
    | "blocked"
    | "unknown";
  message: string;
}

export interface ActionVerification {
  /** Expected amount delivered to the Safe (base units). */
  expected: BigIntString;
  /** Observed increase in Safe balance. */
  safeDelta: BigIntString | null;
  /** Amount remaining in the source after the transfer. */
  sourceRemaining: BigIntString | null;
  note: string | null;
  blockNumber: BigIntString | null;
}

export interface MigrationAction {
  /** Deterministic intent ID; stable across sessions. */
  id: string;
  chainId: number;
  kind: ActionKind;
  label: string;
  assetIds: string[];
  /** Token contract (erc20/721/1155). */
  contract: Address | null;
  tokenIds: BigIntString[];
  /** Planned amounts (re-read from chain right before sending). */
  amounts: BigIntString[];
  decimals: number;
  symbol: string;
  status: ActionStatus;
  txHash: Hex | null;
  callsId: string | null;
  txNonce: number | null;
  submittedAt: number | null;
  /** Safe balance(s) immediately before sending, for delta verification. */
  safeBalancesBefore: BigIntString[] | null;
  gasLimit: BigIntString | null;
  feeEstimate: BigIntString | null;
  feePaid: BigIntString | null;
  verification: ActionVerification | null;
  error: ActionError | null;
  attempts: number;
}

export type ChainPhase =
  | "idle"
  | "waiting_wallet"
  | "deploying_safe"
  | "verifying_safe"
  | "preparing_transfers"
  | "awaiting_approval"
  | "transferring"
  | "confirming"
  | "verifying_balances"
  | "completed"
  | "failed"
  | "needs_attention";

export type ExecutionStrategy = "atomic_batch" | "sequential";

export interface BatchRecord {
  callsId: string;
  actionIds: string[];
  submittedAt: number;
  statusCode: number | null;
  atomic: boolean | null;
  transactionHashes: Hex[];
}

export interface ChainMigration {
  chainId: number;
  safeAddress: Address;
  safeVersion: SupportedSafeVersion;
  contracts: SafeContractSet;
  strategy: ExecutionStrategy;
  phase: ChainPhase;
  message: string | null;
  actions: MigrationAction[];
  batches: BatchRecord[];
  safeVerification: SafeInspection | null;
}

export interface Migration {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  updatedAt: number;
  source: Address;
  environment: Environment;
  safeConfig: SafeConfig;
  /** Owners that proved control with a fresh EIP-712 signature bound to this configuration. */
  verifiedOwners: Address[];
  chains: ChainMigration[];
  runState: "idle" | "running" | "paused" | "finished";
  log: MigrationLogEntry[];
}

export interface MigrationLogEntry {
  at: number;
  chainId: number | null;
  actionId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  txHash?: Hex;
}
