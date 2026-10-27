import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { MigrationAction } from "@/lib/domain/types";
import { buildReceipt, receiptToJson } from "@/lib/services/receipt";
import { pdfSafe, renderReceiptPdf } from "@/lib/services/receipt-pdf";
import { sampleMigration, SEPOLIA } from "./fixtures";

/** Set RECEIPT_PDF_OUT=<dir> to keep the generated files for visual inspection (pdftoppm). */
const out = process.env.RECEIPT_PDF_OUT;
function keep(name: string, pdf: Uint8Array, json: string) {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.pdf`), pdf);
  writeFileSync(join(out, `${name}.json`), json);
}

describe("receipt PDF", () => {
  it("renders a partial run on one page with its hash and exceptions", async () => {
    const r = buildReceipt({ migration: sampleMigration(), generatedAt: 1_700_000_200_000, app: { version: "0.1.0", commit: "abc123def456" } });
    const pdf = await renderReceiptPdf(r);
    keep("partial", pdf, receiptToJson(r));
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Safe Migrator receipt run-0001");
  });

  it("paginates a large run with many assets and long reasons", async () => {
    const m = sampleMigration();
    const base = m.chains[0]!.actions[1]!;
    const many: MigrationAction[] = Array.from({ length: 80 }, (_, i) => ({
      ...base,
      id: `${SEPOLIA}:transfer_erc721:0x${(i + 1).toString(16).padStart(40, "0")}:${i}`,
      kind: "transfer_erc721",
      label: `Transfer Extremely Long Collection Name Number ${i} With Unicode ✓ → #${i}`,
      tokenIds: [String(10n ** 30n + BigInt(i))],
      amounts: ["1"],
      status: i % 7 === 0 ? "failed" : "verified",
      error: i % 7 === 0 ? { code: "reverted", message: "Transaction reverted onchain. Nothing moved. ".repeat(6) } : null,
      txHash: `0x${(i + 16).toString(16).padStart(64, "a")}`,
    }));
    m.chains[0]!.actions = [...m.chains[0]!.actions, ...many];
    const r = buildReceipt({ migration: m, generatedAt: 1_700_000_200_000 });
    const pdf = await renderReceiptPdf(r);
    keep("large", pdf, receiptToJson(r));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(3);
  });

  it("transliterates characters the built-in fonts cannot draw", () => {
    expect(pdfSafe("a…b → c ≈ d ✓ é")).toBe("a...b -> c ~ d ? é");
  });
});
