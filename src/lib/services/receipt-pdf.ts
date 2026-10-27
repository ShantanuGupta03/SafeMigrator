import { PDFDocument, PDFName, PDFString, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import QRCode from "qrcode";
import { explorerAddressUrl, explorerTxUrl, findChain } from "@/lib/chains/registry";
import { formatAmount, formatFee } from "@/lib/domain/amounts";
import { outcomeHeadline, RECEIPT_HASH_ALGORITHM, type Receipt } from "./receipt";

/*
 * Paginated PDF rendering of a receipt. Every fact comes from the same `Receipt` object as the JSON
 * export, and the PDF prints that receipt's integrity hash so both can be matched. Built-in PDF
 * fonts only cover Latin-1, so text is transliterated where needed.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(0.4, 0.4, 0.4);
const TONES: Record<"success" | "warning" | "danger", { fill: RGB; ink: RGB }> = {
  success: { fill: rgb(0.86, 0.96, 0.88), ink: rgb(0.06, 0.35, 0.16) },
  warning: { fill: rgb(1, 0.94, 0.8), ink: rgb(0.5, 0.3, 0) },
  danger: { fill: rgb(1, 0.88, 0.88), ink: rgb(0.6, 0.05, 0.05) },
};

const REPLACEMENTS: Record<string, string> = { "…": "...", "→": "->", "≈": "~", "—": "-", "–": "-", "“": '"', "”": '"', "‘": "'", "’": "'", "·": "-", "×": "x", "≤": "<=", "≥": ">=" };

/** Maps text to what the standard (WinAnsi) fonts can draw; anything else becomes "?". */
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    if (REPLACEMENTS[ch]) out += REPLACEMENTS[ch];
    else {
      const c = ch.codePointAt(0)!;
      out += (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? ch : c === 10 ? " " : "?";
    }
  }
  return out;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN + 24) this.newPage();
  }

  /** Wraps on spaces; tokens wider than a line (hashes) are broken by character. */
  lines(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    let line = "";
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
    for (const word of pdfSafe(text).split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      let rest = word;
      while (!fits(rest)) {
        let i = rest.length;
        while (i > 1 && !fits(rest.slice(0, i))) i--;
        out.push(rest.slice(0, i));
        rest = rest.slice(i);
      }
      line = rest;
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  text(text: string, opts: { size?: number; font?: keyof Fonts; color?: RGB; indent?: number; gap?: number; link?: string } = {}) {
    const size = opts.size ?? 9.5;
    const font = this.fonts[opts.font ?? "regular"];
    const x = MARGIN + (opts.indent ?? 0);
    const width = A4.width - MARGIN - x;
    const leading = size * 1.35;
    for (const l of this.lines(text, font, size, width)) {
      this.ensure(leading);
      this.y -= leading;
      this.page.drawText(l, { x, y: this.y, size, font, color: opts.color ?? INK });
      if (opts.link) this.linkRect(x, this.y - 2, font.widthOfTextAtSize(l, size), size + 3, opts.link);
    }
    this.y -= opts.gap ?? 0;
  }

  /** Label/value pair; long values wrap under the label column. */
  field(label: string, value: string, opts: { mono?: boolean; link?: string } = {}) {
    const labelWidth = 130;
    // Monospaced values are hashes and addresses; 8 pt keeps a 32-byte hash on one line.
    const size = opts.mono ? 8 : 9.5;
    const valueLines = this.lines(value, opts.mono ? this.fonts.mono : this.fonts.regular, size, A4.width - 2 * MARGIN - labelWidth);
    const leading = size * 1.35;
    this.ensure(leading * Math.min(valueLines.length, 3));
    valueLines.forEach((l, i) => {
      this.ensure(leading);
      this.y -= leading;
      if (i === 0) this.page.drawText(pdfSafe(label), { x: MARGIN, y: this.y, size: 9.5, font: this.fonts.bold, color: MUTED });
      const font = opts.mono ? this.fonts.mono : this.fonts.regular;
      this.page.drawText(l, { x: MARGIN + labelWidth, y: this.y, size, font, color: INK });
      if (opts.link) this.linkRect(MARGIN + labelWidth, this.y - 2, font.widthOfTextAtSize(l, size), size + 3, opts.link);
    });
  }

  heading(text: string, size = 13) {
    // Keep a heading together with at least a few lines of its section.
    this.ensure(size * 3 + 40);
    this.y -= size * 0.8;
    this.text(text, { size, font: "bold", gap: 2 });
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness: 0.6, color: rgb(0.8, 0.8, 0.8) });
    this.y -= 4;
  }

  banner(title: string, body: string, tone: keyof typeof TONES) {
    const size = 12;
    const bodyLines = this.lines(body, this.fonts.regular, 9.5, A4.width - 2 * MARGIN - 20);
    const h = 18 + size * 1.4 + bodyLines.length * 9.5 * 1.35;
    this.ensure(h + 8);
    const top = this.y - 6;
    this.page.drawRectangle({ x: MARGIN, y: top - h, width: A4.width - 2 * MARGIN, height: h, color: TONES[tone].fill });
    this.y = top - 8;
    this.text(title, { size, font: "bold", color: TONES[tone].ink, indent: 10 });
    for (const l of bodyLines) this.text(l, { indent: 10, color: TONES[tone].ink });
    this.y = top - h - 8;
  }

  /** A QR code on its own row, with its caption and URL beside it. */
  async qr(url: string, caption: string) {
    const size = 72;
    this.ensure(size + 12);
    const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 256 });
    const png = await this.doc.embedPng(Uint8Array.from(atob(dataUrl.split(",")[1]!), (c) => c.charCodeAt(0)));
    const top = this.y - 4;
    this.page.drawImage(png, { x: MARGIN, y: top - size, width: size, height: size });
    const textX = MARGIN + size + 10;
    this.page.drawText(pdfSafe(caption), { x: textX, y: top - 14, size: 9, font: this.fonts.bold, color: INK });
    const urlLines = this.lines(url, this.fonts.mono, 7.5, A4.width - MARGIN - textX);
    urlLines.forEach((l, i) => {
      const y = top - 28 - i * 10;
      this.page.drawText(l, { x: textX, y, size: 7.5, font: this.fonts.mono, color: MUTED });
      this.linkRect(textX, y - 2, this.fonts.mono.widthOfTextAtSize(l, 7.5), 10, url);
    });
    this.y = top - size - 6;
  }

  linkRect(x: number, y: number, w: number, h: number, url: string) {
    const annot = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    this.page.node.addAnnot(this.doc.context.register(annot));
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const STATUS_TEXT: Record<string, string> = {
  verified: "verified",
  verified_with_discrepancy: "verified WITH DISCREPANCY",
  skipped: "skipped",
  planned: "NOT STARTED",
  rejected: "REJECTED",
  failed: "FAILED",
  needs_attention: "NEEDS ATTENTION",
  uncertain: "UNCERTAIN (outcome unknown)",
  submitted: "SUBMITTED (not yet verified)",
  verifying: "VERIFYING (not yet verified)",
  awaiting_wallet: "AWAITING WALLET",
};

/** Renders a receipt as a paginated A4 PDF. */
export async function renderReceiptPdf(r: Receipt): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Safe Migrator receipt ${r.record.migrationId}`);
  doc.setCreator("Safe Migrator");
  doc.setProducer("Safe Migrator (pdf-lib)");
  doc.setCreationDate(new Date(r.generatedAt));
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const w = new Writer(doc, fonts);
  const rec = r.record;
  const head = outcomeHeadline(r);

  w.text("Safe Migrator - migration receipt", { size: 18, font: "bold", gap: 2 });
  w.text(`Generated ${iso(r.generatedAt)} - ${rec.environment === "testnet" ? "testnet" : "production networks"} - run ${rec.migrationId}`, { color: MUTED, gap: 6 });
  w.banner(head.title, rec.outcomeScope, head.tone);

  w.heading("Summary");
  w.field("Source wallet", rec.source, { mono: true });
  const safes = [...new Set(rec.chains.map((c) => c.safeAddress))];
  w.field(safes.length > 1 ? "Safe addresses" : "Safe address", safes.join(", "), { mono: true });
  w.field("Owners", `${rec.destination.threshold} of ${rec.destination.owners.length} (original configuration)`);
  for (const o of rec.destination.owners) w.field("", o, { mono: true });
  w.field("Deployment commitment", rec.destination.deploymentCommitment ?? "unknown (run predates saved profiles)", { mono: !!rec.destination.deploymentCommitment });
  w.field("Owner proofs on record", rec.ownerVerification.verifiedOwners.length ? `${rec.ownerVerification.verifiedOwners.length} (${rec.ownerVerification.method})` : rec.ownerVerification.waivedOnTestnet ? "none (optional on testnets)" : "none");
  w.field("Purpose", rec.purpose);
  w.field("Run created / last update", `${iso(rec.createdAt)} / ${iso(rec.lastUpdatedAt)}`);
  w.field("App build", `${r.app.version ?? "unknown version"} - commit ${r.app.commit ?? "unknown"}`);

  const failed = rec.chains.flatMap((c) => c.actions.filter((a) => !["verified", "verified_with_discrepancy", "skipped"].includes(a.status)).map((a) => ({ c, a })));
  const scope = rec.scope;
  w.heading("Exceptions");
  let any = false;
  if (!scope) {
    any = true;
    w.text("The original selection was not recorded for this run (older record): blocked networks and excluded assets are unknown.", { color: TONES.warning.ink });
  }
  for (const b of scope?.blockedChains ?? []) {
    any = true;
    w.text(`Network not migrated - ${findChain(b.chainId)?.name ?? b.chainId}: ${b.reasons.join(" ")}`);
  }
  for (const a of scope?.excludedAssets ?? []) {
    any = true;
    w.text(`Asset excluded - ${a.label} on ${findChain(a.chainId)?.name ?? a.chainId}: ${a.reason ?? "no reason recorded"}`);
  }
  for (const d of scope?.incompleteDiscovery ?? []) {
    any = true;
    w.text(`Incomplete discovery - ${d.note}`);
  }
  for (const d of rec.discrepancies) {
    any = true;
    const c = rec.chains.find((x) => x.chainId === d.chainId);
    const dec = c?.actions.find((a) => a.id === d.actionId)?.decimals ?? 0;
    w.text(`Amount discrepancy - ${d.label}: expected ${formatAmount(d.expectedRaw, dec)} (${d.expectedRaw} raw), Safe received ${d.verifiedRaw ? `${formatAmount(d.verifiedRaw, dec)} (${d.verifiedRaw} raw)` : "unknown"}. ${d.note ?? ""}`);
  }
  for (const { c, a } of failed) {
    any = true;
    w.text(`${STATUS_TEXT[a.status] ?? a.status} - ${a.label} on ${c.network}${a.error ? `: ${a.error.message}` : ""}`, { color: TONES.danger.ink });
  }
  if (!any) w.text("None recorded.", { color: MUTED });

  for (const c of rec.chains) {
    w.heading(`${c.network} - ${c.outcome.replace(/_/g, " ")}`);
    w.field("Safe", c.safeAddress, { mono: true, link: explorerAddressUrl(c.chainId, c.safeAddress) });
    w.field("Version / strategy", `Safe v${c.safeVersion} - ${c.strategy === "atomic_batch" ? "atomic batch (EIP-5792)" : "one transaction at a time"}`);
    w.field(
      "Deployment",
      c.deployment.how === "deployed_in_this_run" ? "deployed in this run" : c.deployment.how === "already_deployed" ? "already deployed before this run" : c.deployment.how === "not_completed" ? "NOT COMPLETED" : "unknown",
    );
    if (c.deployment.txHash) w.field("Deployment tx", c.deployment.txHash, { mono: true, link: explorerTxUrl(c.chainId, c.deployment.txHash) });
    w.field(
      "Verified during run",
      c.verifiedAtMigration
        ? `${c.verifiedAtMigration.threshold} of ${c.verifiedAtMigration.owners.length} owners, no modules: ${c.verifiedAtMigration.modules.length === 0 ? "yes" : "no"}, guard: ${c.verifiedAtMigration.guard ?? "none"} - block ${c.verifiedAtMigration.blockNumber}${c.verifiedAtMigration.blockHash ? ` (${c.verifiedAtMigration.blockHash})` : ""}`
        : "unknown (the run did not record a verification)",
    );
    if (c.reviewedGovernance) w.field("Reviewed governance", `${c.reviewedGovernance.threshold} of ${c.reviewedGovernance.owners.length} owners at block ${c.reviewedGovernance.observedAtBlock} (changed since deployment)`);
    await w.qr(explorerAddressUrl(c.chainId, c.safeAddress), `Safe on the ${c.network} block explorer`);
    w.field("Network fees paid", `${formatFee(c.fees.paidRaw, c.nativeDecimals)} ${c.nativeSymbol}${c.fees.actionsWithUnknownFee ? ` (+${c.fees.actionsWithUnknownFee} with unknown fee)` : ""}`);
    w.y -= 4;
    for (const a of c.actions.filter((x) => x.kind !== "deploy_safe")) {
      w.text(`${a.label} - ${STATUS_TEXT[a.status] ?? a.status}`, { font: "bold", gap: 0 });
      const planned = a.display.planned ? `${a.display.planned} (${a.amounts.plannedRaw.join(", ")} raw)` : a.amounts.plannedRaw.join(", ");
      const verified = a.amounts.verifiedDeltaRaw !== null ? `${a.display.verified ?? a.amounts.verifiedDeltaRaw} (${a.amounts.verifiedDeltaRaw} raw, evidence: ${a.evidence ?? "unknown"})` : "not verified";
      w.text(`Planned ${planned}. Verified at the Safe: ${verified}.`, { indent: 10 });
      if (a.note) w.text(a.note, { indent: 10, color: MUTED });
      if (a.txHash) w.text(`tx ${a.txHash}`, { indent: 10, font: "mono", size: 8, link: explorerTxUrl(c.chainId, a.txHash) });
      else if (a.callsId) w.text(`batch ${a.callsId}`, { indent: 10, font: "mono", size: 8 });
      w.y -= 3;
    }
    for (const b of c.batches) w.text(`Batch ${b.callsId}: ${b.state}, status ${b.statusCode ?? "unknown"}, atomic ${b.atomic ?? "unknown"}, ${b.transactionHashes.length} tx`, { font: "mono", size: 8 });
  }

  if (r.currentState) {
    w.heading("Current state (live re-read, not part of the record)");
    w.text(r.currentState.label, { color: MUTED });
    for (const c of r.currentState.chains) {
      const name = findChain(c.chainId)?.name ?? c.chainId;
      if (c.error) {
        w.text(`${name}: could not re-read (${c.error})`, { color: TONES.warning.ink });
        continue;
      }
      w.text(
        `${name} at block ${c.blockNumber ?? "?"} (${iso(c.observedAt)}): ${c.safe ? `${c.safe.threshold} of ${c.safe.owners.length} owners${c.safe.issues.length ? ` - ${c.safe.issues.join(" ")}` : ""}` : "Safe not read"}`,
        { font: "bold" },
      );
      if (c.remainingInSource) {
        w.text(
          `Still in the source wallet: ${c.remainingInSource.length ? c.remainingInSource.map((x) => `${formatAmount(x.balanceRaw, x.decimals)} ${x.symbol}${x.classification !== "transferable" ? ` (${x.classification})` : ""}`).join(", ") : "nothing detected"}. Detection covers indexed tokens, known tokens and manual imports only.`,
          { indent: 10 },
        );
      }
    }
  }

  w.heading("Integrity");
  w.field("Algorithm", `${RECEIPT_HASH_ALGORITHM} (SHA-256 over canonical JSON without the integrity field)`);
  w.field("Receipt hash", r.integrity.hash, { mono: true });
  w.text(
    "This hash commits to the content of the matching JSON receipt. It is not a signature and does not certify anything by itself. Check the JSON with the receipt inspector (/receipt) and the transactions on a block explorer.",
    { color: MUTED },
  );

  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    p.drawText(pdfSafe(`Safe Migrator receipt ${r.integrity.hash.slice(0, 18)}... - page ${i + 1} of ${total}`), { x: MARGIN, y: 24, size: 7.5, font: fonts.regular, color: MUTED });
  });
  doc.catalog.set(PDFName.of("Lang"), PDFString.of("en"));
  return doc.save();
}
