import { describe, expect, it } from "vitest";
import { executionGate, safeWalletUrl } from "@/lib/chains/registry";
import { validateRpcPayload } from "@/lib/chains/rpc-policy";
import { classifyAsset, isAutoSelectable, isManuallySelectable, isPreselectable } from "@/lib/services/discovery/classification";
import { classifyAccountCode, isUserRejection } from "@/lib/services/wallet-connection";
import { SAFE, SEPOLIA, TOKEN } from "./fixtures";

const base = { chainId: SEPOLIA, standard: "erc20" as const, contract: TOKEN, name: "Demo", symbol: "DMO", indexerSpam: false, metadataVerified: true };

describe("asset classification", () => {
  it("treats plain tokens as transferable", () => {
    expect(classifyAsset(base).classification).toBe("transferable");
    expect(classifyAsset({ ...base, standard: "native", contract: null }).classification).toBe("transferable");
  });

  it("flags spam and phishing patterns", () => {
    expect(classifyAsset({ ...base, name: "Claim reward at evil.xyz" }).classification).toBe("suspicious");
    expect(classifyAsset({ ...base, indexerSpam: true }).flags).toContain("indexer_spam");
    expect(classifyAsset({ ...base, symbol: "UЅDC" }).flags).toContain("non_ascii_symbol");
  });

  it("flags impersonation of well-known symbols on production networks only", () => {
    expect(classifyAsset({ ...base, chainId: 1, symbol: "USDC" }).classification).toBe("suspicious");
    expect(classifyAsset({ ...base, symbol: "USDC" }).classification).toBe("transferable");
  });

  it("routes protocol positions to specialized handling", () => {
    expect(classifyAsset({ ...base, name: "Aave Ethereum USDC", symbol: "aEthUSDC" }).classification).toBe("specialized");
    expect(classifyAsset({ ...base, name: "Variable Debt USDC", symbol: "variableDebtUSDC" }).classification).toBe("non_transferable");
    expect(classifyAsset({ ...base, standard: "erc721", symbol: "UNI-V3-POS", name: "Uniswap V3 Positions" }).classification).toBe("specialized");
    expect(classifyAsset({ ...base, name: "Staked Demo" }).classification).toBe("specialized");
  });

  it("marks unsupported networks and unreadable metadata", () => {
    expect(classifyAsset({ ...base, chainId: 999999 }).classification).toBe("unsupported");
    expect(classifyAsset({ ...base, metadataVerified: false }).classification).toBe("unsupported");
  });

  it("pre-selects only assets with an independent trust signal", () => {
    const t = { classification: "transferable" as const, usdValue: null };
    expect(isPreselectable({ ...t, standard: "native", sources: ["rpc"] })).toBe(true);
    expect(isPreselectable({ ...t, standard: "erc20", sources: ["indexer"] })).toBe(false);
    expect(isPreselectable({ ...t, standard: "erc20", sources: ["indexer"], usdValue: 12 })).toBe(true);
    expect(isPreselectable({ ...t, standard: "erc20", sources: ["manual"] })).toBe(true);
    expect(isPreselectable({ ...t, standard: "erc20", sources: ["known_list"], classification: "suspicious" })).toBe(false);
  });

  it("never auto-selects suspicious or unsupported assets", () => {
    expect(isAutoSelectable("transferable")).toBe(true);
    expect(isAutoSelectable("suspicious")).toBe(false);
    expect(isManuallySelectable("suspicious")).toBe(true);
    expect(isManuallySelectable("specialized")).toBe(false);
    expect(isManuallySelectable("non_transferable")).toBe(false);
  });
});

describe("execution gating", () => {
  it("enables testnets and blocks production networks by default", () => {
    expect(executionGate(SEPOLIA).enabled).toBe(true);
    const main = executionGate(1);
    expect(main.enabled).toBe(false);
    expect(main.requiresVerifiedOwners).toBe(true);
    expect(executionGate(424242).enabled).toBe(false);
  });

  it("requires both the flag and the per-chain allowlist", () => {
    const cfg = (enable: boolean, chains: number[]) => ({
      enableMainnetExecution: enable,
      mainnetExecutionChains: chains,
      gasLimitMarginBps: 12_000,
      feeMarginBps: 12_500,
      dustFeeMultiple: 3,
      walletConnectProjectId: null,
    });
    expect(executionGate(8453, cfg(true, [1]) as never).enabled).toBe(false);
    expect(executionGate(8453, cfg(true, [8453]) as never).enabled).toBe(true);
    expect(executionGate(8453, cfg(false, [8453]) as never).enabled).toBe(false);
  });

  it("builds Safe{Wallet} links with the EIP-3770 prefix", () => {
    expect(safeWalletUrl(SEPOLIA, SAFE)).toBe(`https://app.safe.global/home?safe=sep:${SAFE}`);
  });
});

describe("RPC proxy policy", () => {
  it("forwards read-only methods only", () => {
    expect(validateRpcPayload({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }).ok).toBe(true);
    const denied = validateRpcPayload({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    expect(validateRpcPayload([{ method: "eth_chainId" }, { method: "personal_sign" }])).toMatchObject({ ok: false, status: 403 });
  });

  it("limits batch size and rejects malformed bodies", () => {
    expect(validateRpcPayload(Array.from({ length: 51 }, () => ({ method: "eth_chainId" })))).toMatchObject({ ok: false, status: 413 });
    expect(validateRpcPayload([])).toMatchObject({ ok: false });
    expect(validateRpcPayload("x")).toMatchObject({ ok: false });
  });
});

describe("wallet helpers", () => {
  it("classifies EOAs, EIP-7702 delegated EOAs and contracts", () => {
    expect(classifyAccountCode(undefined).accountType).toBe("unknown");
    expect(classifyAccountCode("0x").accountType).toBe("eoa");
    const delegated = classifyAccountCode(`0xef0100${TOKEN.slice(2)}`);
    expect(delegated.accountType).toBe("eip7702_delegated");
    expect(delegated.delegate?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(classifyAccountCode("0x6080604052").accountType).toBe("contract");
  });

  it("detects user rejections, including nested causes", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: 5750 })).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error("boom"))).toBe(false);
  });
});
