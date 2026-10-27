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
  /** Set only by a protocol adapter that identified this asset from onchain registry reads. */
  protocol?: { adapter: "aave-v3"; market: string; pool: Address; underlying: Address };
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

/**
 * A verified owner signature. Records without `schema` are legacy v1 challenges (bound to the
 * configuration hash only); `owner-ack-v2` also binds the pinned deployment commitment and the
 * invitation's scope, and is what v1.5 creates.
 */
export interface OwnerVerification {
  method: "eip712";
  schema?: "owner-ack-v2";
  signature: Hex;
  nonce: Hex;
  issuedAt: number;
  configHash: Hex;
  verifiedAt: number;
  /** Signature verified as plain ECDSA (EOA) or via ERC-1271/6492 (contract wallet). */
  signerType: "eoa" | "contract";
  /** Network the signature's EIP-712 domain names; ERC-1271 signatures are only checked there. */
  chainId: number;
  /* v2 only */
  expiresAt?: number;
  deploymentCommitment?: Hex;
  scopeChainIds?: number[];
  safeAddress?: Address;
  profileId?: string;
  source?: Address;
  environment?: Environment;
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
  /** Hash of the block the inspection was read at, when the RPC returned it. */
  blockHash?: Hex | null;
}

export type SafeTargetStatus =
  | "not_deployed"
  | "deployed_matching"
  /** A Safe from the pinned recipe whose owners, threshold or security settings were changed after deployment. */
  | "deployed_governance_changed"
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
  /** Resolved from a saved profile's pinned recipe (no version negotiation). */
  pinned?: boolean;
  /** The RPC could not be read; the status says nothing about the chain itself. */
  unavailable?: boolean;
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
  | "needs_attention"
  /** May or may not have been broadcast. Never retried automatically; see `MigrationAction.uncertainty`. */
  | "uncertain";

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
    /** The wallet or node refused before broadcasting (definitive). */
    | "not_submitted"
    /** Submission outcome unknown (timeout, lost response, closed session). */
    | "submission_unknown"
    /** The transaction's nonce was consumed by something else; it can no longer land. */
    | "not_landed"
    /** The amount to move differs materially from what the user reviewed. */
    | "amount_changed"
    | "unknown";
  message: string;
}

/** Evidence gathered while an action's submission outcome is unknown. */
export interface Uncertainty {
  reason: string;
  /** Source nonce the wallet was expected to use when it was prompted. */
  nonce: number | null;
  latestNonce: number | null;
  pendingNonce: number | null;
  checkedAt: number;
  /** Only true when no broadcast could be detected; the user may then confirm nothing was sent. */
  userMayConfirmNotSent: boolean;
  /** A transaction that looks related but could not be proven to be this action. */
  candidateTxHash: Hex | null;
}

/** How a transfer's outcome was established, strongest first. */
export type VerificationEvidence = "receipt_logs" | "log_search" | "balance_only" | "end_state";

export interface ActionVerification {
  /** Expected amount delivered to the Safe (base units). */
  expected: BigIntString;
  /** Observed increase in Safe balance. */
  safeDelta: BigIntString | null;
  /** Amount remaining in the source after the transfer. */
  sourceRemaining: BigIntString | null;
  note: string | null;
  blockNumber: BigIntString | null;
  /** Amount the Safe received according to this action's own transfer events. */
  loggedAmount?: BigIntString | null;
  evidence?: VerificationEvidence | null;
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
  /** Token IDs and amounts the user reviewed; larger deviations need renewed confirmation. */
  previewTokenIds?: BigIntString[];
  previewAmounts?: BigIntString[];
  /** Latest block when the wallet was prompted; lower bound for searching this action's events. */
  promptBlock?: BigIntString | null;
  /** Block at which `safeBalancesBefore` was read. */
  snapshotBlock?: BigIntString | null;
  uncertainty?: Uncertainty | null;
  /** Protocol position moved by a plain transfer under an adapter's rules (rechecked before sending). */
  protocol?: { adapter: "aave-v3"; market: string; pool: Address; underlying: Address } | null;
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
  /** "requested": recorded before wallet_sendCalls returned, under the id the app proposed. */
  state?: "requested" | "submitted";
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
  /**
   * Owners and threshold the user reviewed for an already deployed Safe whose governance changed
   * since deployment. When set, execution verifies the live Safe against this instead of `safeConfig`.
   */
  expectedGovernance?: ExpectedGovernance | null;
}

export type MigrationPurpose = "migration" | "extension" | "sweep";

/** The full security state of an existing Safe that the user reviewed and accepted. */
export interface ExpectedGovernance {
  owners: Address[];
  threshold: number;
  singleton: Address | null;
  fallbackHandler: Address | null;
  guard: Address | null;
  modules: Address[];
  /** Block of the observation the user reviewed. */
  observedAtBlock: BigIntString;
}

export interface Migration {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  updatedAt: number;
  source: Address;
  environment: Environment;
  safeConfig: SafeConfig;
  /**
   * Owners whose proof validated when the migration was created. Informational only: execution
   * re-validates `ownerProofs` cryptographically and never trusts this list.
   */
  verifiedOwners: Address[];
  ownerProofs?: OwnerProof[];
  /** Testnet-only: the user chose to run without the recommended owner verification. */
  ownerVerificationWaived?: boolean;
  /** What the user selected versus what this migration can execute. Absent on older records. */
  scope?: MigrationScope | null;
  chains: ChainMigration[];
  runState: "idle" | "running" | "paused" | "finished";
  /** Saved Safe profile this run belongs to (v1.5+). Absent on older records. */
  profileId?: string | null;
  /** Commitment to the pinned deployment recipe the run used (v1.5+). */
  deploymentCommitment?: Hex | null;
  purpose?: MigrationPurpose;
  log: MigrationLogEntry[];
}

export interface OwnerProof {
  owner: Address;
  verification: OwnerVerification;
}

export interface ScopeAsset {
  assetId: string;
  chainId: number;
  label: string;
  amount: BigIntString;
  decimals: number;
  /** Why it is not part of the executable plan (null when included). */
  reason: string | null;
}

export interface ScopeChain {
  chainId: number;
  reasons: string[];
  assetIds: string[];
}

export interface MigrationScope {
  /** Networks the user had selected when the migration was created. */
  selectedChainIds: number[];
  /** Every asset in the effective selection (selected network + selected + still discovered). */
  selectedAssets: ScopeAsset[];
  includedChainIds: number[];
  /** Selected networks that could not run, with the blockers shown at review time. */
  blockedChains: ScopeChain[];
  /** Selected assets that will not move (blocked network or failed simulation), with reasons. */
  excludedAssets: ScopeAsset[];
  /** The user explicitly accepted that only part of the selection will migrate. */
  partialAcknowledged: boolean;
  /** Networks whose discovery was partial or failed when the plan was made. */
  incompleteDiscovery: { chainId: number; note: string }[];
  plannedAt: number;
}

export interface MigrationLogEntry {
  at: number;
  chainId: number | null;
  actionId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  txHash?: Hex;
}
