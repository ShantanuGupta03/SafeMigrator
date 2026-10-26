// Captures README screenshots against a running server (npm run start -- -p 3100).
// Uses a read-only mock wallet that only reports an address; discovery reads real testnet data.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const ACCOUNT = process.env.SCREENSHOT_ACCOUNT ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript((account) => {
  window.ethereum = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
    },
    on: () => {},
    removeListener: () => {},
  };
}, ACCOUNT);

await page.goto(BASE);
await page.screenshot({ path: `${OUT}connect.png` });
await page.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
await page.getByRole("button", { name: /Continue/ }).click();
await page.getByRole("heading", { name: "Here's what your wallet holds." }).waitFor();
await page.waitForFunction(() => !document.body.innerText.includes("Scanning"), null, { timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}discover.png`, fullPage: true });

const next = page.getByRole("button", { name: /Choose signers/ });
if (await next.isEnabled()) {
  await next.click();
  await page.getByRole("heading", { name: "Choose who controls your Safe." }).waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}signers.png`, fullPage: true });

  const inputs = page.getByPlaceholder("0x… or name.eth");
  await page.getByRole("button", { name: /Use connected wallet/ }).click();
  await inputs.nth(1).fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await inputs.nth(2).fill("0x8617E340B3D01FA5F11F306F4090FD50E238070D".toLowerCase());
  await inputs.nth(2).press("Tab");
  await page.getByText("Same Safe address on every selected network").or(page.getByText("Different addresses per network")).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}signers-filled.png`, fullPage: true });
  const review = page.getByRole("button", { name: /Review migration/ });
  if (await review.isEnabled()) {
    await review.click();
    await page.getByRole("heading", { name: "Everything ready for the move?" }).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes("Simulating transactions"), null, { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}preview.png`, fullPage: true });
  }
}
await browser.close();
console.log(`Screenshots written to ${OUT}`);
