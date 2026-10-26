import type { Address, Chain } from "viem";
import { getAddress } from "viem";
import { arbitrum, base, baseSepolia, gnosisChiado, mainnet, optimism, polygon, sepolia } from "viem/chains";
import { appConfig, type AppConfig } from "@/lib/config";
import type { Environment } from "@/lib/domain/types";

export interface KnownToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Tokens whose balance changes without transfers. */
  rebasing?: boolean;
}

export interface ChainConfig {
  id: number;
  key: string;
  name: string;
  /** EIP-3770 short name used by Safe{Wallet}. */
  shortName: string;
  environment: Environment;
  viemChain: Chain;
  nativeSymbol: string;
  nativeDecimals: number;
  publicRpcUrls: string[];
  explorerUrl: string;
  blockscoutUrl: string | null;
  alchemyNetwork: string | null;
  /** Blocks to wait after inclusion before treating a tx as final for this PoC. */
  confirmations: number;
  /** OP-stack chains charge an extra L1 data fee not included in estimateGas. */
  opStack: boolean;
  safeWalletSupported: boolean;
  color: string;
  knownTokens: KnownToken[];
  faucets: { name: string; url: string }[];
}

const t = (address: string, symbol: string, name: string, decimals: number, rebasing = false): KnownToken => ({
  address: getAddress(address),
  symbol,
  name,
  decimals,
  rebasing,
});

export const CHAINS: readonly ChainConfig[] = [
  {
    id: sepolia.id,
    key: "sepolia",
    name: "Sepolia",
    shortName: "sep",
    environment: "testnet",
    viemChain: sepolia,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
    explorerUrl: "https://sepolia.etherscan.io",
    blockscoutUrl: "https://eth-sepolia.blockscout.com",
    alchemyNetwork: "eth-sepolia",
    confirmations: 1,
    opStack: false,
    safeWalletSupported: true,
    color: "#7B8CFF",
    knownTokens: [t("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "USDC", "USDC (Circle testnet)", 6)],
    faucets: [
      { name: "Google Cloud Sepolia faucet", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
      { name: "Alchemy Sepolia faucet", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
      { name: "Circle USDC faucet", url: "https://faucet.circle.com" },
    ],
  },
  {
    id: gnosisChiado.id,
    key: "chiado",
    name: "Gnosis Chiado",
    shortName: "chi",
    environment: "testnet",
    viemChain: gnosisChiado,
    nativeSymbol: "xDAI",
    nativeDecimals: 18,
    publicRpcUrls: ["https://rpc.chiadochain.net", "https://gnosis-chiado-rpc.publicnode.com"],
    explorerUrl: "https://gnosis-chiado.blockscout.com",
    blockscoutUrl: "https://gnosis-chiado.blockscout.com",
    alchemyNetwork: null,
    confirmations: 1,
    opStack: false,
    safeWalletSupported: true,
    color: "#3E6957",
    knownTokens: [],
    faucets: [{ name: "Gnosis Chiado faucet", url: "https://faucet.chiadochain.net" }],
  },
  {
    id: baseSepolia.id,
    key: "base-sepolia",
    name: "Base Sepolia",
    shortName: "basesep",
    environment: "testnet",
    viemChain: baseSepolia,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    explorerUrl: "https://sepolia.basescan.org",
    blockscoutUrl: "https://base-sepolia.blockscout.com",
    alchemyNetwork: "base-sepolia",
    confirmations: 1,
    opStack: true,
    safeWalletSupported: true,
    color: "#0052FF",
    knownTokens: [t("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "USDC (Circle testnet)", 6)],
    faucets: [
      { name: "Coinbase Developer Platform faucet", url: "https://portal.cdp.coinbase.com/products/faucet" },
      { name: "Alchemy Base Sepolia faucet", url: "https://www.alchemy.com/faucets/base-sepolia" },
      { name: "Superchain faucet", url: "https://console.optimism.io/faucet" },
    ],
  },
  {
    id: mainnet.id,
    key: "ethereum",
    name: "Ethereum",
    shortName: "eth",
    environment: "mainnet",
    viemChain: mainnet,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    explorerUrl: "https://etherscan.io",
    blockscoutUrl: "https://eth.blockscout.com",
    alchemyNetwork: "eth-mainnet",
    confirmations: 2,
    opStack: false,
    safeWalletSupported: true,
    color: "#627EEA",
    knownTokens: [
      t("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", "USD Coin", 6),
      t("0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "Tether USD", 6),
      t("0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", "Dai Stablecoin", 18),
      t("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", "Wrapped Ether", 18),
      t("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "stETH", "Liquid staked Ether", 18, true),
      t("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH", "Wrapped liquid staked Ether", 18),
      t("0x5aFE3855358E112B5647B952709E6165e1c1eEEe", "SAFE", "Safe Token", 18),
    ],
    faucets: [],
  },
  {
    id: base.id,
    key: "base",
    name: "Base",
    shortName: "base",
    environment: "mainnet",
    viemChain: base,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    explorerUrl: "https://basescan.org",
    blockscoutUrl: "https://base.blockscout.com",
    alchemyNetwork: "base-mainnet",
    confirmations: 2,
    opStack: true,
    safeWalletSupported: true,
    color: "#0052FF",
    knownTokens: [
      t("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "USD Coin", 6),
      t("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18),
    ],
    faucets: [],
  },
  {
    id: arbitrum.id,
    key: "arbitrum",
    name: "Arbitrum One",
    shortName: "arb1",
    environment: "mainnet",
    viemChain: arbitrum,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    explorerUrl: "https://arbiscan.io",
    blockscoutUrl: "https://arbitrum.blockscout.com",
    alchemyNetwork: "arb-mainnet",
    confirmations: 2,
    opStack: false,
    safeWalletSupported: true,
    color: "#28A0F0",
    knownTokens: [
      t("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", "USD Coin", 6),
      t("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", "Tether USD", 6),
      t("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "WETH", "Wrapped Ether", 18),
      t("0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB", "Arbitrum", 18),
    ],
    faucets: [],
  },
  {
    id: optimism.id,
    key: "optimism",
    name: "OP Mainnet",
    shortName: "oeth",
    environment: "mainnet",
    viemChain: optimism,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpcUrls: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
    explorerUrl: "https://optimistic.etherscan.io",
    blockscoutUrl: "https://optimism.blockscout.com",
    alchemyNetwork: "opt-mainnet",
    confirmations: 2,
    opStack: true,
    safeWalletSupported: true,
    color: "#FF0420",
    knownTokens: [
      t("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USDC", "USD Coin", 6),
      t("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18),
      t("0x4200000000000000000000000000000000000042", "OP", "Optimism", 18),
    ],
    faucets: [],
  },
  {
    id: polygon.id,
    key: "polygon",
    name: "Polygon PoS",
    shortName: "matic",
    environment: "mainnet",
    viemChain: polygon,
    nativeSymbol: "POL",
    nativeDecimals: 18,
    publicRpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
    explorerUrl: "https://polygonscan.com",
    blockscoutUrl: "https://polygon.blockscout.com",
    alchemyNetwork: "polygon-mainnet",
    confirmations: 3,
    opStack: false,
    safeWalletSupported: true,
    color: "#8247E5",
    knownTokens: [
      t("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", "USD Coin", 6),
      t("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", "Tether USD", 6),
      t("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "WETH", "Wrapped Ether", 18),
    ],
    faucets: [],
  },
];

const BY_ID = new Map(CHAINS.map((c) => [c.id, c]));

export function getChain(chainId: number): ChainConfig {
  const chain = BY_ID.get(chainId);
  if (!chain) throw new Error(`Unsupported chain ${chainId}`);
  return chain;
}

export function findChain(chainId: number): ChainConfig | undefined {
  return BY_ID.get(chainId);
}

export function chainsForEnvironment(env: Environment): ChainConfig[] {
  return CHAINS.filter((c) => c.environment === env);
}

export interface ExecutionGate {
  enabled: boolean;
  reason: string | null;
  /** When true, at least `threshold` owners must be signature-verified before execution. */
  requiresVerifiedOwners: boolean;
}

/**
 * Execution gating. Testnets always execute. Production networks only execute when the build
 * enables them explicitly AND the chain is in the allowlist.
 */
export function executionGate(chainId: number, config: AppConfig = appConfig): ExecutionGate {
  const chain = findChain(chainId);
  if (!chain) return { enabled: false, reason: "Network is not supported.", requiresVerifiedOwners: true };
  if (chain.environment === "testnet") return { enabled: true, reason: null, requiresVerifiedOwners: false };
  if (!config.enableMainnetExecution) {
    return {
      enabled: false,
      reason: "Production-network execution is disabled in this build (discovery only).",
      requiresVerifiedOwners: true,
    };
  }
  if (!config.mainnetExecutionChains.includes(chainId)) {
    return {
      enabled: false,
      reason: `${chain.name} has not been validated for execution in this deployment.`,
      requiresVerifiedOwners: true,
    };
  }
  return { enabled: true, reason: null, requiresVerifiedOwners: true };
}

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${getChain(chainId).explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  return `${getChain(chainId).explorerUrl}/address/${address}`;
}

export function safeWalletUrl(chainId: number, safe: string): string | null {
  const chain = getChain(chainId);
  if (!chain.safeWalletSupported) return null;
  return `https://app.safe.global/home?safe=${chain.shortName}:${safe}`;
}

export function isKnownToken(chainId: number, address: string): KnownToken | undefined {
  const lower = address.toLowerCase();
  return findChain(chainId)?.knownTokens.find((k) => k.address.toLowerCase() === lower);
}
