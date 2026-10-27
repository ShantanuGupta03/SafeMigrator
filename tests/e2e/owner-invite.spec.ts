import { expect, test } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installMockWallet, setBalance } from "./mock-wallet";

/**
 * Remote owner verification between two ISOLATED browser contexts (separate storage, separate
 * wallets). Needs local chains with the canonical Safe contracts: run with `npm run test:e2e:local`.
 * Wallets are mocks backed by throwaway keys; they sign EIP-712 and refuse every transaction.
 */
test.skip(!process.env.LOCAL_CHAIN, "needs local chains (npm run test:e2e:local)");
test.setTimeout(180_000);

const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

test("a co-owner verifies on another device through a link and a returned signed response", async ({ browser }) => {
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const carol = privateKeyToAccount(generatePrivateKey());
  for (const id of ["11155111", "10200", "84532"]) await setBalance(process.env[`LOCAL_RPC_${id}`]!, alice.address, 10n ** 18n);

  // Device A: the initiator.
  const initiatorCtx = await browser.newContext();
  const initiator = await initiatorCtx.newPage();
  const aliceCalls = await installMockWallet(initiator, alice);
  await initiator.goto("/");
  await initiator.getByRole("button", { name: /Connect Wallet|Injected/ }).first().click();
  await initiator.getByRole("button", { name: /Continue/ }).click();
  await expect(initiator.getByRole("heading", { name: "Here's what your wallet holds." })).toBeVisible();
  await expect(initiator.getByRole("button", { name: /Choose signers/ })).toBeEnabled({ timeout: 60_000 });
  await initiator.getByRole("button", { name: /Choose signers/ }).click();

  await initiator.getByRole("button", { name: /Use connected wallet/ }).click();
  for (const [i, who] of [[2, bob], [3, carol]] as const) {
    const input = initiator.getByLabel(`Signer ${i} address`);
    await input.fill(who.address);
    await input.blur();
  }
  await expect(initiator.getByText("Same Safe address on every selected network")).toBeVisible({ timeout: 60_000 });
  await initiator.getByRole("button", { name: /Freeze configuration for verification/ }).click();
  const bobRow = initiator.getByTestId(`owner-row-${bob.address}`);
  await bobRow.getByRole("button", { name: "Invite" }).click();
  const link = (await initiator.getByTestId("invite-link").textContent({ timeout: 10_000 }))!.trim();
  expect(link).toMatch(/\/invite#i=[A-Za-z0-9_-]+$/);

  // Device B: the co-owner, with nothing but the link.
  const coOwnerCtx = await browser.newContext();
  const coOwner = await coOwnerCtx.newPage();
  const bobCalls = await installMockWallet(coOwner, bob, 10200);
  await coOwner.goto(link);
  await expect(coOwner.getByText("You have been asked to confirm Safe ownership.")).toBeVisible();
  await expect(coOwner.getByText(/Recomputed on/)).toBeVisible({ timeout: 60_000 });
  await expect(coOwner.getByText("2 of 3")).toBeVisible();
  await coOwner.getByRole("button", { name: /Injected|MetaMask|Browser/ }).first().click();
  await coOwner.getByRole("button", { name: /Sign acknowledgement/ }).click();
  const response = await coOwner.getByLabel("Signed response").inputValue();
  expect(JSON.parse(response)).toMatchObject({ k: "owner-invite-response", chainId: 10200 });

  // Back on device A: an altered response is rejected, the real one verifies once.
  const tampered = JSON.parse(response);
  tampered.invite.threshold = 1;
  await initiator.getByLabel("Signed response").fill(JSON.stringify(tampered));
  await initiator.getByRole("button", { name: "Import response" }).click();
  await expect(initiator.getByText(/does not match the invitation/)).toBeVisible();

  await initiator.getByLabel("Signed response").fill(response);
  await initiator.getByRole("button", { name: "Import response" }).click();
  await expect(initiator.getByText(new RegExp(`${shortAddr(bob.address).slice(0, 8)}.*verified \\(signed on Gnosis Chiado`))).toBeVisible();
  await expect(bobRow.getByText("Verified", { exact: true })).toBeVisible();

  await initiator.getByLabel("Signed response").fill(response);
  await initiator.getByRole("button", { name: "Import response" }).click();
  await expect(initiator.getByText(/already imported/)).toBeVisible();
  await expect(initiator.getByText(/1\/3 owners verified/)).toBeVisible();

  // Owner verification never produced a transaction prompt on either device.
  expect(aliceCalls.filter((c) => c.startsWith("eth_sendTransaction"))).toEqual([]);
  expect(bobCalls.filter((c) => c.startsWith("eth_sendTransaction"))).toEqual([]);
  expect(bobCalls).toContain("eth_signTypedData_v4");
  await initiatorCtx.close();
  await coOwnerCtx.close();
});
