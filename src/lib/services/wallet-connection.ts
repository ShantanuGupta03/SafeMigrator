import { getAddress, type Address, type Hex, type PublicClient } from "viem";

export type AccountType = "eoa" | "eip7702_delegated" | "contract" | "unknown";

export interface WalletDescriptor {
  connectorName: string;
  connectorId: string;
  accountType: AccountType;
  delegate: Address | null;
}

const EIP7702_PREFIX = "0xef0100";

/** Classifies the connected account by its onchain code (EIP-7702 designators start with 0xef0100). */
export function classifyAccountCode(code: Hex | undefined): { accountType: AccountType; delegate: Address | null } {
  if (code === undefined) return { accountType: "unknown", delegate: null };
  if (code === "0x" || code === "0x0") return { accountType: "eoa", delegate: null };
  const lower = code.toLowerCase();
  if (lower.startsWith(EIP7702_PREFIX) && lower.length === 2 + 46) {
    return { accountType: "eip7702_delegated", delegate: getAddress(`0x${lower.slice(8)}`) };
  }
  return { accountType: "contract", delegate: null };
}

export async function detectAccountType(client: PublicClient, address: Address) {
  try {
    const code = await client.getCode({ address });
    return classifyAccountCode(code ?? "0x");
  } catch {
    return classifyAccountCode(undefined);
  }
}

export function describeAccountType(t: AccountType): string {
  switch (t) {
    case "eoa":
      return "Externally owned account (single key)";
    case "eip7702_delegated":
      return "EOA with EIP-7702 delegation (still controlled by one key)";
    case "contract":
      return "Smart contract wallet";
    default:
      return "Unknown account type";
  }
}

export class WrongAccountError extends Error {
  constructor(expected: Address, actual: string | undefined) {
    super(`Connected account ${actual ?? "none"} is not the migration source ${expected}. Switch accounts in your wallet.`);
    this.name = "WrongAccountError";
  }
}

export class WrongChainError extends Error {
  constructor(expected: number, actual: number | undefined) {
    super(`Wallet is on chain ${actual ?? "unknown"}, expected ${expected}.`);
    this.name = "WrongChainError";
  }
}

export function assertSourceAccount(expected: Address, actual: string | undefined): void {
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) throw new WrongAccountError(expected, actual);
}

/** EIP-1193 / EIP-5792 user rejection codes. */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const err = cur as { code?: number; name?: string; message?: string; cause?: unknown };
    if (err.code === 4001 || err.code === 5750) return true;
    if (err.name === "UserRejectedRequestError") return true;
    if (typeof err.message === "string" && /user (rejected|denied|cancel)/i.test(err.message)) return true;
    cur = err.cause;
  }
  return false;
}

export function errorMessage(e: unknown): string {
  if (!e) return "Unknown error";
  const err = e as { shortMessage?: string; message?: string; details?: string };
  return (err.shortMessage || err.message || String(e)).slice(0, 400);
}
