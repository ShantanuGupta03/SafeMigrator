import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { inspectReceipt } from "@/lib/services/receipt";
import { installMockWallet, setBalance } from "./mock-wallet";

/**
 * The v1.5 workspace end to end through the real UI, on local chains with the canonical Safe
 * contracts (`npm run test:e2e:local`): migrate on two networks, export receipts, inspect the saved
 * Safe, sweep a late arrival without redeploying, and add a third network. The wallet is a mock
 * backed by a throwaway key that sends real transactions to the LOCAL chains only.
 */
test.skip(!process.env.LOCAL_CHAIN, "needs local chains (npm run test:e2e:local)");
test.setTimeout(420_000);

const rpcFor = (id: number) => process.env[`LOCAL_RPC_${id}`]!;
const SEPOLIA = 11155111;

async function reviewAndMigrate(page: Page) {
  await expect(page.getByRole("heading", { name: "Everything ready for the move?" })).toBeVisible();
  await expect(page.getByText("Simulating transactions and estimating gas")).toBeHidden({ timeout: 90_000 });
  await page.getByText(/I have reviewed the destination Safe address/).click();
  await page.getByRole("button", { name: /Migrate to Safe/ }).click();
  await expect(page.getByText("All steps complete.")).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "View results" }).click();
}

test("migrate, export receipts, sweep a late arrival and add a network from a saved Safe", async ({ page }) => {
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const carol = privateKeyToAccount(generatePrivateKey());
  for (const id of ["11155111", "10200", "84532"]) await setBalance(process.env[`LOCAL_RPC_${id}`]!, alice.address, parseEther("1"));
  const calls = await installMockWallet(page, alice, SEPOLIA, { rpcFor });

  await page.goto("/");
  await page.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Here's what your wallet holds." })).toBeVisible();
  await page.getByRole("button", { name: /Base Sepolia/ }).click(); // migrate on Sepolia + Chiado only
  await expect(page.getByRole("button", { name: /Choose signers/ })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: /Choose signers/ }).click();

  await page.getByRole("button", { name: /Use connected wallet/ }).click();
  for (const [i, who] of [[2, bob], [3, carol]] as const) {
    const input = page.getByLabel(`Signer ${i} address`);
    await input.fill(who.address);
    await input.blur();
  }
  await expect(page.getByText("Same Safe address on every selected network")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Review migration/ }).click();
  await expect(page.getByText("A saved Safe will be created")).toBeVisible();
  await reviewAndMigrate(page);

  // Receipts: the JSON verifies offline, the PDF downloads.
  await expect(page.getByRole("heading", { name: "Your assets have a safer home." })).toBeVisible({ timeout: 60_000 });
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Receipt (JSON)" }).click()]);
  const text = await (await json.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  const inspected = inspectReceipt(text);
  expect(inspected).toMatchObject({ ok: true, hashMatches: true, receipt: { record: { outcome: "complete", purpose: "migration" } } });
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Receipt (PDF)" }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.receipt\.pdf$/);

  // Saved Safe: pinned, deployed on two networks, readiness observed.
  await page.getByRole("button", { name: /Saved Safes/ }).click();
  await expect(page.getByText("Setup saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Check readiness/ }).click();
  await expect(page.getByText(/Gnosis Chiado: original owners and threshold/)).toBeVisible({ timeout: 60_000 });

  // A late arrival on Sepolia is detected and swept without a new deployment.
  await setBalance(rpcFor(SEPOLIA), alice.address, parseEther("0.5"));
  await page.getByRole("button", { name: /Check for new assets/ }).click();
  // Base Sepolia's ETH was never migrated, so it is listed too; this sweep takes only the Sepolia top-up.
  await expect(page.getByRole("checkbox", { name: "Select ETH on Base Sepolia" })).toBeVisible({ timeout: 60_000 });
  const row = page.getByRole("checkbox", { name: "Select ETH on Sepolia" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.check();
  const sentBefore = calls.filter((c) => c.startsWith("eth_sendTransaction")).length;
  await page.getByRole("button", { name: /Review sweep/ }).click();
  await expect(page.getByRole("button", { name: /Choose signers/ })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: /Choose signers/ }).click();
  await page.getByRole("button", { name: /Review migration/ }).click();
  await expect(page.getByText(/Saved Safe: Safe 0x/)).toBeVisible();
  await reviewAndMigrate(page);
  // Exactly one transaction: the ETH transfer into the existing Safe on Sepolia. No deployment.
  const safeAddress = inspected.ok ? inspected.receipt.record.chains[0]!.safeAddress : "";
  expect(calls.filter((c) => c.startsWith("eth_sendTransaction")).slice(sentBefore)).toEqual([`eth_sendTransaction:${SEPOLIA}:${safeAddress}`]);

  // Add the third network from the saved Safe, at the same address.
  await page.getByRole("button", { name: /Saved Safes/ }).click();
  await page.getByLabel("Network to add").selectOption({ label: "Base Sepolia" });
  await page.getByRole("button", { name: /Check network/ }).click();
  await page.getByRole("button", { name: /Deploy Safe on Base Sepolia/ }).click();
  await expect(page.getByText("All steps complete.")).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: /Saved Safes/ }).click();
  const base = createPublicClient({ transport: http(rpcFor(84532)) });
  expect(await base.getCode({ address: safeAddress as `0x${string}` })).toMatch(/^0x.{20,}/);
  await expect(page.getByText("Base Sepolia").first()).toBeVisible();
});
