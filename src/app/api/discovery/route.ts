import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { findChain } from "@/lib/chains/registry";
import { discoverWithConfiguredIndexer, sanitizeIndexerTokens } from "@/lib/server/indexers";

export const dynamic = "force-dynamic";

const query = z.object({
  chainId: z.coerce.number().int().positive(),
  owner: z.string().refine((v) => isAddress(v, { strict: false }), "invalid address"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = query.safeParse({ chainId: url.searchParams.get("chainId"), owner: url.searchParams.get("owner") });
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  if (!findChain(parsed.data.chainId)) return NextResponse.json({ error: "Unsupported chain" }, { status: 404 });
  try {
    const result = await discoverWithConfiguredIndexer(parsed.data.chainId, getAddress(parsed.data.owner));
    result.tokens = sanitizeIndexerTokens(result.tokens);
    result.errors = result.errors.map((e) => e.replace(/https?:\/\/\S+/g, "<url>"));
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: `Indexer failure: ${(e as Error).message.replace(/https?:\/\/\S+/g, "<url>")}` },
      { status: 502 },
    );
  }
}
