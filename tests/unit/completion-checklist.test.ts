import { describe, expect, it } from "vitest";
import { buildCompletionChecklist, primaryChecklistAction } from "@/lib/services/completion-checklist";
import { sampleMigration } from "./fixtures";

describe("completion checklist", () => {
  it("separates verified transfers from blocked scope and suggests receipt", () => {
    const items = buildCompletionChecklist(sampleMigration());
    expect(items.some((i) => i.kind === "observed" && i.title.includes("Transfer FEE"))).toBe(true);
    expect(items.some((i) => i.title.includes("Network blocked"))).toBe(true);
    expect(items.some((i) => i.action === "receipt_json")).toBe(true);
    expect(items.some((i) => i.kind === "user_ack" && i.title.includes("Backup"))).toBe(true);
    expect(items.find((i) => i.action === "receipt_json")).toBeTruthy();
    expect(primaryChecklistAction(items)?.action).toBeDefined();
  });

  it("records exact intent on scope when present", () => {
    const m = sampleMigration({
      transferIntents: { [`11155111:erc20:0x7070707070707070707070707070707070707070`]: { mode: "exact", amount: "500000" } },
      scope: {
        ...sampleMigration().scope!,
        selectedAssets: [
          {
            assetId: `11155111:erc20:0x7070707070707070707070707070707070707070`,
            chainId: 11155111,
            label: "FEE",
            amount: "500000",
            decimals: 6,
            transferIntent: { mode: "exact", amount: "500000" },
            reason: null,
          },
        ],
      },
    });
    const r = buildCompletionChecklist(m);
    expect(r.some((i) => i.detail?.includes("Requested"))).toBe(true);
  });
});
