import type { Address, Hex, PublicClient } from "viem";
import { publicActionsL2 } from "viem/op-stack";
import { appConfig } from "@/lib/config";
import { getChain } from "@/lib/chains/registry";
import { applyBpsCeil } from "@/lib/domain/amounts";

export interface FeeQuote {
  /** Fee cap we will put on transactions we construct (includes margin). */
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint | null;
  /** Current effective price, for "typical" display. */
  currentGasPrice: bigint;
  eip1559: boolean;
}

export interface GasMargins {
  gasLimitBps: number;
  feeBps: number;
}

export const defaultMargins = (): GasMargins => ({
  gasLimitBps: appConfig.gasLimitMarginBps,
  feeBps: appConfig.feeMarginBps,
});

/** Conservative pre-deployment gas assumptions; replaced by estimateGas once the Safe exists. */
export const FALLBACK_GAS = {
  nativeToSafe: 40_000n,
  erc721ToSafeOverhead: 30_000n,
  erc1155ToSafeOverhead: 30_000n,
} as const;

export async function getFeeQuote(client: PublicClient, margins: GasMargins = defaultMargins()): Promise<FeeQuote> {
  const currentGasPrice = await client.getGasPrice();
  try {
    const fees = await client.estimateFeesPerGas({ type: "eip1559", chain: client.chain });
    if (fees.maxFeePerGas === undefined) throw new Error("no 1559");
    return {
      maxFeePerGas: applyBpsCeil(fees.maxFeePerGas, margins.feeBps),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      currentGasPrice,
      eip1559: true,
    };
  } catch {
    return {
      maxFeePerGas: applyBpsCeil(currentGasPrice, margins.feeBps),
      maxPriorityFeePerGas: null,
      currentGasPrice,
      eip1559: false,
    };
  }
}

export interface CallLike {
  to: Address;
  data: Hex;
  value: bigint;
}

export async function estimateCallGas(
  client: PublicClient,
  from: Address,
  call: CallLike,
  margins: GasMargins = defaultMargins(),
): Promise<bigint> {
  const gas = await client.estimateGas({ account: from, to: call.to, data: call.data, value: call.value });
  return applyBpsCeil(gas, margins.gasLimitBps);
}

/** OP-stack L1 data fee (not covered by gasLimit * maxFeePerGas). Returns 0 on other chains. */
export async function estimateL1DataFee(client: PublicClient, chainId: number, from: Address, call: CallLike): Promise<bigint> {
  const chain = getChain(chainId);
  if (!chain.opStack) return 0n;
  try {
    const l2 = client.extend(publicActionsL2());
    const fee = await l2.estimateL1Fee({ account: from, to: call.to, data: call.data, value: call.value, chain: chain.viemChain } as never);
    return applyBpsCeil(fee, 20_000);
  } catch {
    // Unknown L1 fee: reserve a conservative fixed amount (0.00005 ETH).
    return 50_000_000_000_000n;
  }
}

export function maxCost(gasLimit: bigint, fee: FeeQuote, l1Fee = 0n): bigint {
  return gasLimit * fee.maxFeePerGas + l1Fee;
}

export function typicalCost(gasLimit: bigint, fee: FeeQuote, l1Fee = 0n): bigint {
  return gasLimit * fee.currentGasPrice + l1Fee;
}

/** Amount of native token that can leave the EOA after reserving every remaining fee. */
export function spendableNative(balance: bigint, reserve: bigint): bigint {
  return balance > reserve ? balance - reserve : 0n;
}

/** Dust: a native transfer that would be worth less than `multiple` times its own fee. */
export function isDust(amount: bigint, ownFee: bigint, multiple = appConfig.dustFeeMultiple): boolean {
  return amount === 0n || amount < ownFee * BigInt(multiple);
}
