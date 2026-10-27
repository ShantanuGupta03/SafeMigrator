import { expect, test } from "@playwright/test";
import { buildReceipt, receiptToJson } from "@/lib/services/receipt";
import { sampleMigration } from "../unit/fixtures";

/** The receipt inspector works offline: loading a file triggers no RPC call and no third-party request. */
test("inspects a receipt locally and flags tampering", async ({ page, baseURL }) => {
  const json = receiptToJson(buildReceipt({ migration: sampleMigration(), generatedAt: 1_700_000_200_000 }));
  const requests: string[] = [];
  await page.goto("/receipt");
  await expect(page.getByRole("heading", { name: "Inspect a migration receipt." })).toBeVisible();
  page.on("request", (r) => requests.push(r.url()));

  await page.getByLabel("Receipt JSON").fill(json);
  await page.getByRole("button", { name: "Inspect pasted receipt" }).click();
  await expect(page.getByText("Integrity hash matches")).toBeVisible();
  await expect(page.getByText("PARTIAL: part of the selection did not migrate")).toBeVisible();
  await expect(page.getByText("Not migrated: Gnosis Chiado")).toBeVisible();

  const tampered = JSON.parse(json);
  tampered.record.chains[0].actions[1].amounts.verifiedDeltaRaw = "1000000";
  await page.getByLabel("Receipt JSON").fill(JSON.stringify(tampered));
  await page.getByRole("button", { name: "Inspect pasted receipt" }).click();
  await expect(page.getByText("Integrity hash does NOT match")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF" })).toBeDisabled();

  const offOrigin = requests.filter((u) => !u.startsWith(baseURL!));
  const rpc = requests.filter((u) => u.includes("/api/rpc"));
  expect(offOrigin).toEqual([]);
  expect(rpc).toEqual([]);
});
