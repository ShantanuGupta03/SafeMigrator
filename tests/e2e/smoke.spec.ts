import { expect, test } from "@playwright/test";

/**
 * Interface smoke tests. The injected wallet below is a MOCK that only answers account/chain
 * queries so the connect flow can be exercised; it cannot sign or send anything.
 */
const MOCK_ACCOUNT = "0x00000000000000000000000000000000000000a1";

test("landing screen explains the product and offers wallet connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your assets deserve more than one key." })).toBeVisible();
  await expect(page.getByText("Move assets from your existing wallet into a multisignature Safe.", { exact: false })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Testnets/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("never asks for a seed phrase or private key", { exact: false })).toBeVisible();
});

test("connects an injected wallet and reaches the portfolio screen", async ({ page }) => {
  await page.addInitScript((account) => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const provider = {
      isMetaMask: false,
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [account];
          case "eth_chainId":
            return "0xaa36a7";
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          default:
            throw Object.assign(new Error(`Mock wallet does not support ${method}`), { code: 4200 });
        }
      },
      on: (e: string, fn: (...a: unknown[]) => void) => {
        (listeners[e] ??= []).push(fn);
      },
      removeListener: () => {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  }, MOCK_ACCOUNT);

  await page.goto("/");
  await page.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Here's what your wallet holds." })).toBeVisible();
});

test("testnet tools page lists faucets and sample assets", async ({ page }) => {
  await page.goto("/testnet");
  await expect(page.getByRole("heading", { name: "Testnet demo assets" })).toBeVisible();
  await expect(page.getByText("Gnosis Chiado faucet")).toBeVisible();
  await expect(page.getByText("Fee-on-transfer token")).toBeVisible();
});

test("RPC proxy refuses signing and broadcast methods", async ({ request }) => {
  const res = await request.post("/api/rpc/11155111", { data: { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] } });
  expect(res.status()).toBe(403);
  const unknownChain = await request.post("/api/rpc/999999", { data: { jsonrpc: "2.0", id: 1, method: "eth_chainId" } });
  expect(unknownChain.status()).toBeGreaterThanOrEqual(400);
});
