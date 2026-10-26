import { errorMessage, isUserRejection } from "./wallet-connection";

export type SubmissionClass = "user_rejected" | "not_submitted" | "ambiguous" | "wrong_session";

/** Classifies wallet/RPC errors after a send was attempted. Only `not_submitted` may fall back automatically. */
export function classifySubmissionError(e: unknown): SubmissionClass {
  if (isUserRejection(e)) return "user_rejected";
  const msg = errorMessage(e).toLowerCase();
  const code = walkCodes(e);
  if (code === 4902 || code === -32603 && /chain.*not.*add/i.test(msg)) return "not_submitted";
  if (/method not found|not supported|unsupported method|does not support|wallet_sendcalls/i.test(msg) && /not|unsupported|unknown/i.test(msg)) {
    return "not_submitted";
  }
  if (/wrong account|wrong chain|not the migration source/i.test(msg)) return "wrong_session";
  if (/timeout|timed out|network|fetch failed|connection|econnreset|socket|503|502|504|429/i.test(msg)) return "ambiguous";
  if (code === -32603 || code === -32005) return "ambiguous";
  return "ambiguous";
}

function walkCodes(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { code?: number }).code;
    if (typeof c === "number") return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
