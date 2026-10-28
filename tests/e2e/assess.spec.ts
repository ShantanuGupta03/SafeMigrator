import { expect, test } from "@playwright/test";

test("assess page loads and explains read-only check", async ({ page }) => {
  await page.goto("/assess");
  await expect(page.getByRole("heading", { name: "Check a wallet" })).toBeVisible();
  await expect(page.getByText("No signing required", { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder("0x… or name.eth")).toBeVisible();
});

test("connect screen links to assess flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Check a wallet without connecting/i })).toBeVisible();
});
