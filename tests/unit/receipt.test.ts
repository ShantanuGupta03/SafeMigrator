import { describe, expect, it } from "vitest";
import { buildReceipt, buildReceiptBody, canonicalJson, inspectReceipt, outcomeHeadline, receiptHash, receiptToJson } from "@/lib/services/receipt";
import { OWNER_B, sampleMigration, SEPOLIA } from "./fixtures";

describe("canonical serialization and hash (test vectors)", () => {
  // Expected values computed independently with Python's json escaping rules and hashlib.sha256.
  it("sorts keys, drops whitespace and escapes strings deterministically", () => {
    const v = { b: 1, a: [true, null, "x"], c: { e: "é", d: "line\n", B: "upper" } };
    expect(canonicalJson(v)).toBe('{"a":[true,null,"x"],"b":1,"c":{"B":"upper","d":"line\\n","e":"é"}}');
    expect(receiptHash(v)).toBe("0xd95ee063760794b662e70c859170374236871b2864cd74d5d9328314f391c3c2");
    expect(receiptHash({ z: [], y: {}, x: "0" })).toBe("0xe4a2bd9b5b7e3a61529aff5fb75d254a9ca0c799448b9b8ea81aa8fbba169e17");
    expect(receiptHash({})).toBe("0x44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("refuses values that have no single canonical form", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: 2 ** 60 })).toThrow();
  });
});

describe("receipt model", () => {
  const receipt = () => buildReceipt({ migration: sampleMigration(), generatedAt: 1_700_000_200_000, app: { version: "0.1.0", commit: "abc123" } });

  it("keeps the hash stable across serialization round trips and key order", () => {
    const r = receipt();
    const text = receiptToJson(r);
    const checked = inspectReceipt(text);
    expect(checked).toMatchObject({ ok: true, hashMatches: true });
    const compact = JSON.stringify(JSON.parse(text));
    expect(inspectReceipt(compact)).toMatchObject({ ok: true, hashMatches: true });
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()), null, 4);
    expect(inspectReceipt(shuffled)).toMatchObject({ ok: true, hashMatches: true });
    expect(buildReceipt({ migration: sampleMigration(), generatedAt: 1_700_000_200_000, app: { version: "0.1.0", commit: "abc123" } }).integrity.hash).toBe(r.integrity.hash);
  });

  it("detects altered amounts, added fields and changed hashes", () => {
    const json = JSON.parse(receiptToJson(receipt()));
    const altered = structuredClone(json);
    altered.record.chains[0].actions[1].amounts.verifiedDeltaRaw = "1000000";
    expect(inspectReceipt(JSON.stringify(altered))).toMatchObject({ ok: true, hashMatches: false });
    const added = structuredClone(json);
    added.record.note = "trust me";
    expect(inspectReceipt(JSON.stringify(added))).toMatchObject({ ok: true, hashMatches: false });
    const caseChanged = structuredClone(json);
    caseChanged.record.source = caseChanged.record.source.toLowerCase();
    expect(inspectReceipt(JSON.stringify(caseChanged))).toMatchObject({ hashMatches: false });
  });

  it("rejects malformed receipts before hashing", () => {
    const json = JSON.parse(receiptToJson(receipt()));
    expect(inspectReceipt(JSON.stringify({ ...json, record: { ...json.record, source: "0x123" } })).ok).toBe(false);
    expect(inspectReceipt(JSON.stringify({ ...json, record: { ...json.record, chains: [{ ...json.record.chains[0], chainId: 999 }] } })).ok).toBe(false);
    expect(inspectReceipt("{").ok).toBe(false);
    expect(inspectReceipt("x".repeat(3 * 1024 * 1024)).ok).toBe(false);
  });

  it("keeps expected, submitted and verified amounts distinct and reports a partial run prominently", () => {
    const r = receipt();
    const fee = r.record.chains[0]!.actions[1]!;
    expect(fee.amounts).toEqual({
      requestedRaw: null,
      intentMode: null,
      reviewedCeilingRaw: null,
      reviewedRaw: ["1000000"],
      plannedRaw: ["1000000"],
      verifiedDeltaRaw: "990000",
      loggedRaw: "990000",
      sourceRemainingRaw: "0",
    });
    expect(fee.display).toEqual({ planned: "1 FEE", verified: "0.99 FEE" });
    expect(r.record.discrepancies).toHaveLength(1);
    expect(r.record.outcome).toBe("partial");
    expect(outcomeHeadline(r).title).toMatch(/^PARTIAL/);
    expect(r.record.outcomeScope).toMatch(/does not mean the source wallet is empty or retired/);
    expect(r.record.scope!.blockedChains[0]!.reasons[0]).toMatch(/Insufficient/);
  });

  it("reports missing historical evidence as unknown rather than inventing it", () => {
    const m = sampleMigration({ scope: undefined, deploymentCommitment: undefined, profileId: undefined, purpose: undefined });
    m.chains[0]!.safeVerification = null;
    const r = buildReceiptBody({ migration: m, generatedAt: 1 });
    expect(r.record.scope).toBeNull();
    expect(r.record.purpose).toBe("unknown");
    expect(r.record.chains[0]!.verifiedAtMigration).toBeNull();
    expect(r.record.outcomeScope).toMatch(/original selection is unknown/);
    expect(r.app).toEqual({ name: "Safe Migrator", version: null, commit: null });
  });

  it("separates a live re-read from the historical record", () => {
    const m = sampleMigration();
    const base = buildReceiptBody({ migration: m, generatedAt: 5 });
    const live = buildReceiptBody({
      migration: m,
      generatedAt: 5,
      live: { [SEPOLIA]: { observedAt: 9, inspection: { ...m.chains[0]!.safeVerification!, owners: [OWNER_B], threshold: 1, blockNumber: "999" }, issues: ["Owners differ"], safeHoldings: null, remaining: null, error: null } },
    });
    expect(live.record).toEqual(base.record);
    expect(live.currentState?.label).toMatch(/Not part of the historical record/);
    expect(live.currentState?.chains[0]?.safe?.owners).toEqual([OWNER_B]);
  });

  it("never includes the debug log, owner signatures or private labels", () => {
    const m = sampleMigration({
      ownerProofs: [{ owner: OWNER_B, verification: { method: "eip712", schema: "owner-ack-v2", signature: `0x${"ee".repeat(65)}`, nonce: `0x${"aa".repeat(32)}`, issuedAt: 1000, configHash: `0x${"bb".repeat(32)}`, verifiedAt: 2000, signerType: "eoa", chainId: SEPOLIA } }],
    });
    const text = receiptToJson(buildReceipt({ migration: m, generatedAt: 1 }));
    expect(text).not.toContain("internal debug line");
    expect(text).not.toContain("ee".repeat(65));
    expect(JSON.parse(text).record.ownerVerification).toEqual({ verifiedOwners: [OWNER_B], method: "owner-ack-v2", waivedOnTestnet: true });
  });
});
