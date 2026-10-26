import type { AssetClassification, AssetFlag, AssetStandard, DiscoveredAsset } from "@/lib/domain/types";
import { findChain, isKnownToken } from "@/lib/chains/registry";

export interface ClassificationInput {
  chainId: number;
  standard: AssetStandard;
  contract: string | null;
  name: string;
  symbol: string;
  indexerSpam: boolean;
  metadataVerified: boolean;
}

export interface ClassificationResult {
  classification: AssetClassification;
  flags: AssetFlag[];
  reasons: string[];
}

const SPAM_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /www\./i,
  /t\.me\//i,
  /\.(com|io|xyz|org|net|app|finance|site|top|live|gift|claims?|fi|cc|vip|pro)\b/i,
  /\b(claim|claimable|reward|rewards|airdrop|visit|voucher|bonus|gift|free|redeem|giveaway|eligible|activate)\b/i,
  /\$\s?\d/,
];

const WELL_KNOWN_SYMBOLS = new Set(["ETH", "WETH", "USDC", "USDT", "DAI", "WBTC", "STETH", "ARB", "OP", "POL", "MATIC", "SAFE"]);

interface PositionRule {
  test: (name: string, symbol: string, standard: AssetStandard) => boolean;
  reason: string;
  classification: AssetClassification;
}

const POSITION_RULES: PositionRule[] = [
  {
    test: (_n, s) => /^(variable|stable)debt/i.test(s),
    reason: "Debt token — account-bound and not transferable.",
    classification: "non_transferable",
  },
  {
    test: (n, s) => /^aave\b/i.test(n) || /^a(eth|bas|arb|opt|pol|gno|ava)[A-Z]/.test(s),
    reason: "Aave aToken: a lending position that may secure outstanding debt. Move it with protocol-aware tooling.",
    classification: "specialized",
  },
  {
    test: (n, s) => /^compound\b/i.test(n) || /^c[A-Z]{3,}$/.test(s),
    reason: "Compound position: requires protocol-aware migration.",
    classification: "specialized",
  },
  {
    test: (_n, s, std) => std === "erc721" && /UNI-V3-POS|-POS$/i.test(s),
    reason: "Concentrated-liquidity position NFT: fees and incentives are account-specific.",
    classification: "specialized",
  },
  {
    test: (n, s) => /(UNI-V2|SLP|\bLP\b|-LP$|BPT|crvLP)/i.test(s) || /\bliquidity\b/i.test(n),
    reason: "Liquidity-pool token: may be staked or gauge-bound; review before moving.",
    classification: "specialized",
  },
  {
    test: (n, s) => /\b(staked|staking|vesting|vested|locked|escrow(ed)?)\b/i.test(n) || /^ve[A-Z]/.test(s),
    reason: "Staking, vesting or locked position: usually cannot be moved with a plain transfer.",
    classification: "specialized",
  },
];

export function hasNonAscii(s: string): boolean {
  return /[^\x20-\x7E]/.test(s);
}

export function classifyAsset(input: ClassificationInput): ClassificationResult {
  const flags: AssetFlag[] = [];
  const reasons: string[] = [];
  const chain = findChain(input.chainId);
  if (!chain) return { classification: "unsupported", flags, reasons: ["Network not supported."] };
  if (input.standard === "native") return { classification: "transferable", flags, reasons };

  const known = input.contract ? isKnownToken(input.chainId, input.contract) : undefined;
  if (known) {
    if (known.rebasing) {
      flags.push("rebasing");
      reasons.push("Rebasing token: balance can change between planning and transfer; a small remainder may stay behind.");
    }
    return { classification: "transferable", flags, reasons };
  }

  const text = `${input.name} ${input.symbol}`;
  let suspicious = false;
  if (input.indexerSpam) {
    flags.push("indexer_spam");
    reasons.push("The indexer reports this contract as spam or a scam.");
    suspicious = true;
  }
  if (SPAM_PATTERNS.some((re) => re.test(text))) {
    flags.push("spam_pattern");
    reasons.push("Name or symbol contains a link or promotional wording typical of phishing tokens.");
    suspicious = true;
  }
  if (hasNonAscii(input.symbol) || hasNonAscii(input.name)) {
    flags.push("non_ascii_symbol");
    reasons.push("Name or symbol uses unusual characters that can imitate real tokens.");
    suspicious = true;
  }
  const normalizedSymbol = input.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (chain.environment === "mainnet" && WELL_KNOWN_SYMBOLS.has(normalizedSymbol)) {
    flags.push("impersonation");
    reasons.push(`Uses the symbol ${input.symbol} but is not the canonical ${input.symbol} contract on ${chain.name}.`);
    suspicious = true;
  }
  if (!input.metadataVerified) {
    flags.push("unverified_metadata");
    reasons.push("Token metadata could not be read onchain.");
  }
  if (suspicious) return { classification: "suspicious", flags, reasons };

  for (const rule of POSITION_RULES) {
    if (rule.test(input.name, input.symbol, input.standard)) {
      flags.push("protocol_position");
      reasons.push(rule.reason);
      return { classification: rule.classification, flags, reasons };
    }
  }
  if (input.standard === "erc20" && !input.metadataVerified) {
    return { classification: "unsupported", flags, reasons: [...reasons, "Without decimals() the amount cannot be shown reliably."] };
  }
  return { classification: "transferable", flags, reasons };
}

/** Only plain transferable assets are eligible for "Select all". */
export function isAutoSelectable(c: AssetClassification): boolean {
  return c === "transferable";
}

/**
 * Pre-selection right after a scan is stricter than "Select all": unsolicited airdrops are rarely
 * flagged on testnets, so only assets with an independent trust signal are pre-selected.
 */
export function isPreselectable(a: Pick<DiscoveredAsset, "classification" | "standard" | "sources" | "usdValue">): boolean {
  if (!isAutoSelectable(a.classification)) return false;
  return a.standard === "native" || a.sources.includes("known_list") || a.sources.includes("manual") || a.usdValue !== null;
}

/** Suspicious assets may be selected only with explicit acknowledgement; others never. */
export function isManuallySelectable(c: AssetClassification): boolean {
  return c === "transferable" || c === "suspicious";
}
