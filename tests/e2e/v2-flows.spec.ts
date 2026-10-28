import { expect, test } from "@playwright/test";

const MOCK_ACCOUNT = "0x00000000000000000000000000000000000000a1";

test("signers screen shows existing Safe destination choice", async ({ page }) => {
  await page.addInitScript((account) => {
    const provider = {
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [account];
          case "eth_chainId":
            return "0xaa36a7";
          default:
            throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
        }
      },
      on: () => {},
      removeListener: () => {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  }, MOCK_ACCOUNT);

  await page.goto("/");
  await page.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Here's what your wallet holds." })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Choose signers/i }).click();
  await expect(page.getByText("Use an existing Safe")).toBeVisible();
  await page.getByRole("button", { name: "Use an existing Safe" }).click();
  await expect(page.getByPlaceholder("Existing Safe address or ENS")).toBeVisible();
});

test("discover shows amount controls when assets are listed", async ({ page }) => {
  await page.addInitScript((account) => {
    const provider = {
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [account];
          case "eth_chainId":
            return "0xaa36a7";
          default:
            throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
        }
      },
      on: () => {},
      removeListener: () => {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  }, MOCK_ACCOUNT);

  await page.goto("/");
  await page.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Here's what your wallet holds." })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Keep gas in this wallet", { exact: false })).toBeVisible();
});
