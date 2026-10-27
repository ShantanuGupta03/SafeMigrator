import {
  getCompatibilityFallbackHandlerDeployment,
  getCreateCallDeployment,
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployment,
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
  getSignMessageLibDeployment,
  getSimulateTxAccessorDeployment,
  type SingletonDeployment,
} from "@safe-global/safe-deployments";
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { proxyFactoryAbi, safeAbi } from "@/lib/abis";
import type {
  ChainSafeTarget,
  SafeConfig,
  SafeContractSet,
  SupportedSafeVersion,
} from "@/lib/domain/types";
import { compareSafeToConfig, inspectSafe } from "./onchain-verification";

/** Newest first. v1.3.0 is the newest version deployed canonically on Gnosis Chiado. */
export const SAFE_VERSION_PREFERENCE: readonly SupportedSafeVersion[] = ["1.4.1", "1.3.0"];

type ContractKey = keyof SafeContractSet;

const GETTERS: Record<ContractKey, (f: { version: string; released: boolean }) => SingletonDeployment | undefined> = {
  singleton: getSafeL2SingletonDeployment,
  proxyFactory: getProxyFactoryDeployment,
  fallbackHandler: getCompatibilityFallbackHandlerDeployment,
  multiSend: getMultiSendDeployment,
  multiSendCallOnly: getMultiSendCallOnlyDeployment,
  signMessageLib: getSignMessageLibDeployment,
  createCall: getCreateCallDeployment,
  simulateTxAccessor: getSimulateTxAccessorDeployment,
};

/** Contracts whose bytecode must match the official codeHash before we deploy. */
export const CRITICAL_CONTRACTS: readonly ContractKey[] = ["singleton", "proxyFactory", "fallbackHandler"];

export interface CanonicalContract {
  address: Address;
  codeHash: Hex;
}

export function canonicalContracts(version: SupportedSafeVersion): Record<ContractKey, CanonicalContract> {
  const out = {} as Record<ContractKey, CanonicalContract>;
  for (const key of Object.keys(GETTERS) as ContractKey[]) {
    const d = GETTERS[key]({ version, released: true });
    const canonical = d?.deployments.canonical;
    if (!canonical) throw new Error(`safe-deployments has no canonical ${key} for v${version}`);
    out[key] = { address: getAddress(canonical.address), codeHash: canonical.codeHash as Hex };
  }
  return out;
}

/** Canonical addresses of every contract of a Safe version (no onchain check). */
export function canonicalContractSet(version: SupportedSafeVersion): SafeContractSet {
  const c = canonicalContracts(version);
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.address])) as unknown as SafeContractSet;
}

export interface VersionCheck {
  version: SupportedSafeVersion;
  ok: boolean;
  contracts: SafeContractSet;
  issues: string[];
}

/** Verifies onchain that the canonical singleton, factory and fallback handler have the official bytecode. */
export async function verifyCanonicalContracts(client: PublicClient, version: SupportedSafeVersion): Promise<VersionCheck> {
  const canonical = canonicalContracts(version);
  const issues: string[] = [];
  const contracts = Object.fromEntries(
    Object.entries(canonical).map(([k, v]) => [k, v.address]),
  ) as unknown as SafeContractSet;
  await Promise.all(
    CRITICAL_CONTRACTS.map(async (key) => {
      const { address, codeHash } = canonical[key];
      const code = await client.getCode({ address });
      if (!code || code === "0x") {
        issues.push(`v${version} ${key} is not deployed at ${address}.`);
      } else if (keccak256(code).toLowerCase() !== codeHash.toLowerCase()) {
        issues.push(`v${version} ${key} at ${address} does not match the official bytecode.`);
      }
    }),
  );
  return { version, ok: issues.length === 0, contracts, issues };
}

export interface NegotiationResult {
  /** Version used on every compatible chain (same address). Null if no common version exists or the result is indeterminate. */
  commonVersion: SupportedSafeVersion | null;
  /**
   * Chains whose RPC could not be read. An unreachable chain is not evidence that a version is
   * missing there, so while this is non-empty no common version is chosen: picking one from the
   * reachable subset could change the Safe address once the chain is reachable again.
   */
  unavailable: number[];
  perChain: Record<number, { version: SupportedSafeVersion | null; contracts: SafeContractSet | null; issues: string[] }>;
}

/**
 * Picks the newest Safe version whose canonical contracts are verified on ALL given chains so the
 * Safe address is identical everywhere. Chains that cannot use it fall back to their own best
 * version (and therefore a different, explicitly displayed address).
 */
export async function negotiateSafeVersion(
  chainIds: readonly number[],
  clientFor: (chainId: number) => PublicClient,
  preference: readonly SupportedSafeVersion[] = SAFE_VERSION_PREFERENCE,
): Promise<NegotiationResult> {
  const checks = new Map<number, VersionCheck[]>();
  const rpcErrors = new Map<number, string>();
  await Promise.all(
    chainIds.map(async (id) => {
      try {
        checks.set(id, await Promise.all(preference.map((v) => verifyCanonicalContracts(clientFor(id), v))));
      } catch (e) {
        rpcErrors.set(id, `Could not verify Safe contracts: ${(e as Error).message.slice(0, 120)}`);
      }
    }),
  );
  return decideNegotiation(chainIds, checks, rpcErrors, preference);
}

/** Pure decision step of `negotiateSafeVersion`, separated for testing. */
export function decideNegotiation(
  chainIds: readonly number[],
  checks: ReadonlyMap<number, VersionCheck[]>,
  rpcErrors: ReadonlyMap<number, string>,
  preference: readonly SupportedSafeVersion[] = SAFE_VERSION_PREFERENCE,
): NegotiationResult {
  const reachable = chainIds.filter((id) => checks.has(id));
  const unavailable = chainIds.filter((id) => rpcErrors.has(id));
  const commonVersion =
    reachable.length === 0 || unavailable.length > 0
      ? null
      : (preference.find((v) => reachable.every((id) => checks.get(id)!.find((c) => c.version === v)?.ok)) ?? null);

  const perChain: NegotiationResult["perChain"] = {};
  for (const id of chainIds) {
    const err = rpcErrors.get(id);
    if (err) {
      perChain[id] = { version: null, contracts: null, issues: [err] };
      continue;
    }
    const list = checks.get(id)!;
    if (unavailable.length > 0) {
      perChain[id] = { version: null, contracts: null, issues: [`Safe version not chosen: could not reach ${unavailable.length} network(s) of this environment, so the shared address cannot be fixed yet.`] };
      continue;
    }
    const pick = list.find((c) => c.version === commonVersion && c.ok) ?? list.find((c) => c.ok);
    perChain[id] = pick
      ? {
          version: pick.version,
          contracts: pick.contracts,
          issues:
            commonVersion && pick.version !== commonVersion
              ? [`Uses Safe v${pick.version}; the address will differ from other networks.`]
              : [],
        }
      : { version: null, contracts: null, issues: list.flatMap((c) => c.issues) };
  }
  return { commonVersion, unavailable, perChain };
}

/* -------------------------------------------------------------------------- */
/*                       Independent CREATE2 computation                      */
/* -------------------------------------------------------------------------- */

export function encodeSetupInitializer(config: SafeConfig, fallbackHandler: Address): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [config.owners, BigInt(config.threshold), zeroAddress, "0x", fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

export function computeSafeAddress(params: {
  factory: Address;
  singleton: Address;
  initializer: Hex;
  saltNonce: bigint;
  proxyCreationCode: Hex;
}): Address {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(params.initializer), params.saltNonce]));
  const bytecode = concat([params.proxyCreationCode, pad(params.singleton, { size: 32 })]);
  return getContractAddress({ opcode: "CREATE2", from: params.factory, salt, bytecode });
}

export interface DeploymentTx {
  to: Address;
  value: bigint;
  data: Hex;
}

/**
 * Decodes an SDK-generated deployment transaction and rejects anything other than a plain
 * owners/threshold setup through the expected factory, singleton and fallback handler.
 */
export function inspectDeploymentTransaction(tx: DeploymentTx, config: SafeConfig, contracts: SafeContractSet): string[] {
  const issues: string[] = [];
  if (tx.to.toLowerCase() !== contracts.proxyFactory.toLowerCase()) issues.push("Deployment targets an unexpected factory.");
  if (tx.value !== 0n) issues.push("Deployment transaction carries value.");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: proxyFactoryAbi, data: tx.data });
  } catch {
    return [...issues, "Deployment calldata is not createProxyWithNonce."];
  }
  if (decoded.functionName !== "createProxyWithNonce") return [...issues, "Unexpected factory method."];
  const [singleton, initializer, saltNonce] = decoded.args as readonly [Address, Hex, bigint];
  const reencoded = encodeFunctionData({
    abi: proxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [singleton, initializer, saltNonce],
  });
  if (reencoded.toLowerCase() !== tx.data.toLowerCase()) issues.push("Deployment calldata has unexpected trailing bytes.");
  if (singleton.toLowerCase() !== contracts.singleton.toLowerCase()) issues.push("Unexpected singleton.");
  if (saltNonce.toString() !== config.saltNonce) issues.push("Unexpected salt nonce.");
  const expectedInit = encodeSetupInitializer(config, contracts.fallbackHandler);
  if (initializer.toLowerCase() !== expectedInit.toLowerCase()) {
    issues.push("Setup initializer differs from the expected owners/threshold-only configuration (delegatecall, modules, or payment).");
  }
  return issues;
}

/** The CREATE2 address a (validated) deployment transaction will produce, computed from its own calldata. */
export async function deploymentTargetAddress(client: PublicClient, tx: DeploymentTx): Promise<Address> {
  const { args } = decodeFunctionData({ abi: proxyFactoryAbi, data: tx.data });
  const [singleton, initializer, saltNonce] = args as readonly [Address, Hex, bigint];
  const proxyCreationCode = await client.readContract({ address: tx.to, abi: proxyFactoryAbi, functionName: "proxyCreationCode" });
  return computeSafeAddress({ factory: tx.to, singleton, initializer, saltNonce, proxyCreationCode });
}

/* -------------------------------------------------------------------------- */
/*                              Protocol Kit glue                             */
/* -------------------------------------------------------------------------- */

function eip1193(client: PublicClient) {
  return {
    request: ({ method, params }: { method: string; params?: unknown }) =>
      client.request({ method, params } as never) as Promise<unknown>,
  };
}

async function initProtocolKit(chainId: number, client: PublicClient, config: SafeConfig, version: SupportedSafeVersion, contracts: SafeContractSet) {
  const { default: Safe } = await import("@safe-global/protocol-kit");
  return Safe.init({
    provider: eip1193(client),
    predictedSafe: {
      safeAccountConfig: { owners: config.owners, threshold: config.threshold },
      safeDeploymentConfig: { saltNonce: config.saltNonce, safeVersion: version },
    },
    // Force the L2 singleton everywhere: Protocol Kit defaults to L1 on Ethereum, which would change the address.
    isL1SafeSingleton: false,
    // Pin the onchain-verified canonical contracts so the SDK cannot pick another deployment type.
    contractNetworks: {
      [chainId.toString()]: {
        safeSingletonAddress: contracts.singleton,
        safeProxyFactoryAddress: contracts.proxyFactory,
        fallbackHandlerAddress: contracts.fallbackHandler,
        multiSendAddress: contracts.multiSend,
        multiSendCallOnlyAddress: contracts.multiSendCallOnly,
        signMessageLibAddress: contracts.signMessageLib,
        createCallAddress: contracts.createCall,
        simulateTxAccessorAddress: contracts.simulateTxAccessor,
      },
    },
  });
}

export interface PredictionResult {
  sdkAddress: Address;
  independentAddress: Address;
  issues: string[];
}

/** Predicts via Protocol Kit, then cross-checks with an independent CREATE2 computation. */
export async function predictSafe(
  chainId: number,
  client: PublicClient,
  config: SafeConfig,
  version: SupportedSafeVersion,
  contracts: SafeContractSet,
): Promise<PredictionResult> {
  const chainIdOnRpc = await client.getChainId();
  if (chainIdOnRpc !== chainId) throw new Error(`RPC reports chain ${chainIdOnRpc}, expected ${chainId}.`);

  const kit = await initProtocolKit(chainId, client, config, version, contracts);
  const sdkAddress = getAddress(await kit.getAddress());

  const proxyCreationCode = await client.readContract({
    address: contracts.proxyFactory,
    abi: proxyFactoryAbi,
    functionName: "proxyCreationCode",
  });
  const initializer = encodeSetupInitializer(config, contracts.fallbackHandler);
  const independentAddress = computeSafeAddress({
    factory: contracts.proxyFactory,
    singleton: contracts.singleton,
    initializer,
    saltNonce: BigInt(config.saltNonce),
    proxyCreationCode,
  });

  const issues: string[] = [];
  if (sdkAddress !== independentAddress) {
    issues.push(`Protocol Kit predicted ${sdkAddress} but independent CREATE2 computation gives ${independentAddress}.`);
  }
  return { sdkAddress, independentAddress, issues };
}

/** Builds the deployment transaction with Protocol Kit and validates it before it is ever shown to the wallet. */
export async function buildDeploymentTransaction(
  chainId: number,
  client: PublicClient,
  config: SafeConfig,
  version: SupportedSafeVersion,
  contracts: SafeContractSet,
): Promise<DeploymentTx> {
  const kit = await initProtocolKit(chainId, client, config, version, contracts);
  const raw = await kit.createSafeDeploymentTransaction();
  const tx: DeploymentTx = { to: getAddress(raw.to), value: BigInt(raw.value), data: raw.data as Hex };
  const issues = inspectDeploymentTransaction(tx, config, contracts);
  if (issues.length) throw new Error(`Refusing deployment transaction: ${issues.join(" ")}`);
  return tx;
}

/** Full per-chain resolution: version, prediction, cross-check, existing-deployment check. */
export async function resolveChainTarget(
  chainId: number,
  client: PublicClient,
  config: SafeConfig,
  negotiated: NegotiationResult["perChain"][number],
): Promise<ChainSafeTarget> {
  if (!negotiated.version || !negotiated.contracts) {
    return {
      chainId,
      safeVersion: null,
      contracts: null,
      predictedAddress: null,
      status: "incompatible",
      inspection: null,
      issues: negotiated.issues.length ? negotiated.issues : ["No compatible canonical Safe deployment found."],
    };
  }
  try {
    const prediction = await predictSafe(chainId, client, config, negotiated.version, negotiated.contracts);
    if (prediction.issues.length) {
      return {
        chainId,
        safeVersion: negotiated.version,
        contracts: negotiated.contracts,
        predictedAddress: null,
        status: "error",
        inspection: null,
        issues: prediction.issues,
      };
    }
    const inspection = await inspectSafe(client, prediction.sdkAddress);
    let status: ChainSafeTarget["status"] = "not_deployed";
    const issues = [...negotiated.issues];
    if (inspection.hasCode) {
      const mismatch = compareSafeToConfig(inspection, config, negotiated.contracts);
      status = mismatch.length ? "deployed_mismatch" : "deployed_matching";
      issues.push(...mismatch);
    }
    return {
      chainId,
      safeVersion: negotiated.version,
      contracts: negotiated.contracts,
      predictedAddress: prediction.sdkAddress,
      status,
      inspection,
      issues,
    };
  } catch (e) {
    return {
      chainId,
      safeVersion: negotiated.version,
      contracts: negotiated.contracts,
      predictedAddress: null,
      status: "error",
      inspection: null,
      issues: [`Prediction failed: ${(e as Error).message.slice(0, 200)}`],
    };
  }
}
