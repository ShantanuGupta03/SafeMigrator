import { NextResponse } from "next/server";
import { findChain } from "@/lib/chains/registry";
import { validateRpcPayload } from "@/lib/chains/rpc-policy";
import { checkRateLimit, clientKey } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

function upstreamUrls(chainId: number): string[] {
  const chain = findChain(chainId);
  if (!chain) return [];
  const configured = process.env[`RPC_URL_${chainId}`]?.trim();
  return configured ? [configured, ...chain.publicRpcUrls] : [...chain.publicRpcUrls];
}

const MAX_BODY_BYTES = 256_000;

export async function POST(request: Request, ctx: { params: Promise<{ chainId: string }> }) {
  const { chainId: raw } = await ctx.params;
  const chainId = Number(raw);
  const limit = checkRateLimit(`rpc:${clientKey(request)}:${chainId}`, 120, 60_000);
  if (!limit.ok) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const urls = upstreamUrls(chainId);
  if (!Number.isSafeInteger(chainId) || urls.length === 0) {
    return NextResponse.json({ error: "Unsupported chain" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const validation = validateRpcPayload(body);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: validation.status });
  const payload = validation.isBatch ? validation.requests : validation.requests[0];

  let lastError = "No upstream available";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = `Upstream HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  // Never leak upstream URLs (they may embed API keys).
  return NextResponse.json({ error: `All RPC upstreams failed: ${lastError.replace(/https?:\/\/\S+/g, "<url>")}` }, { status: 502 });
}
