import { createPublicClient, custom, getAddress, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { challengeTypedData, createChallenge, verifyChallengeSignature, CHALLENGE_TTL_MS } from "@/lib/services/ownership-verification";
import {
  buildSafeConfig,
  deriveSaltNonce,
  looksLikeEns,
  MAX_OWNERS,
  parseAddressInput,
  safeConfigHash,
  signerWarnings,
  sortOwners,
  thresholdRisk,
  validateSigners,
} from "@/lib/services/signer-configuration";
import { CONFIG, OWNER_B, OWNER_C, SOURCE, slot } from "./fixtures";

describe("signer validation", () => {
  it("accepts three distinct valid owners", () => {
    expect(validateSigners([slot(0, SOURCE), slot(1, OWNER_B), slot(2, OWNER_C)], 2)).toEqual([]);
  });

  it("rejects duplicates regardless of case", () => {
    const lower = getAddress(OWNER_B).toLowerCase() as `0x${string}`;
    const issues = validateSigners([slot(0, SOURCE), slot(1, OWNER_B), slot(2, lower)], 2);
    expect(issues.map((i) => i.code)).toEqual(["duplicate"]);
  });

  it("rejects empty, invalid, zero and unresolved-ENS signers", () => {
    const issues = validateSigners([slot(0, null, ""), slot(1, null, "0x123"), slot(2, zeroAddress)], 2);
    expect(issues.map((i) => i.code)).toEqual(["empty", "invalid", "zero_address"]);
    expect(validateSigners([slot(0, SOURCE), slot(1, OWNER_B), slot(2, null, "nobody.eth")], 2)[0]?.code).toBe("unresolved_ens");
  });

  it("rejects bad thresholds and owner counts", () => {
    expect(validateSigners([slot(0, SOURCE), slot(1, OWNER_B), slot(2, OWNER_C)], 4).some((i) => i.code === "threshold")).toBe(true);
    expect(validateSigners([slot(0, SOURCE), slot(1, OWNER_B), slot(2, OWNER_C)], 0).some((i) => i.code === "threshold")).toBe(true);
    expect(validateSigners([], 1).some((i) => i.code === "count")).toBe(true);
    const eleven = Array.from({ length: MAX_OWNERS + 1 }, (_, i) => slot(i, privateKeyToAccount(generatePrivateKey()).address));
    expect(validateSigners(eleven, 2).some((i) => i.code === "count")).toBe(true);
  });

  it("accepts any owner count from 1 to the maximum with a valid threshold", () => {
    expect(validateSigners([slot(0, SOURCE)], 1)).toEqual([]);
    expect(validateSigners([slot(0, SOURCE), slot(1, OWNER_B)], 2)).toEqual([]);
    const five = Array.from({ length: 5 }, (_, i) => slot(i, privateKeyToAccount(generatePrivateKey()).address));
    expect(validateSigners(five, 3)).toEqual([]);
  });

  it("flags thresholds that a single stolen or lost key defeats", () => {
    expect(thresholdRisk(2, 3)).toBeNull();
    expect(thresholdRisk(3, 5)).toBeNull();
    expect(thresholdRisk(1, 1)?.message).toMatch(/single key/);
    expect(thresholdRisk(1, 3)?.message).toMatch(/stolen key/);
    expect(thresholdRisk(3, 3)?.message).toMatch(/lost/);
  });

  it("changes the Safe address commitment when owners or threshold change", () => {
    const two = buildSafeConfig([SOURCE, OWNER_B], 2, CONFIG.saltNonce);
    const twoOfThree = buildSafeConfig([SOURCE, OWNER_B, OWNER_C], 2, CONFIG.saltNonce);
    const threeOfThree = buildSafeConfig([SOURCE, OWNER_B, OWNER_C], 3, CONFIG.saltNonce);
    expect(new Set([safeConfigHash(two), safeConfigHash(twoOfThree), safeConfigHash(threeOfThree)]).size).toBe(3);
  });

  it("enforces checksums on mixed-case input", () => {
    expect(parseAddressInput("0x52908400098527886E0F7030069857D2E4169EE7")).toBe("0x52908400098527886E0F7030069857D2E4169EE7");
    expect(parseAddressInput("0x52908400098527886e0F7030069857D2E4169EE7")).toBeNull();
    expect(parseAddressInput("0x52908400098527886e0f7030069857d2e4169ee7")).not.toBeNull();
    expect(looksLikeEns("vitalik.eth")).toBe(true);
    expect(looksLikeEns("0xabc.eth")).toBe(false);
  });
});

describe("deterministic configuration", () => {
  it("sorts owners so input order does not change the Safe", () => {
    const a = buildSafeConfig([OWNER_C, SOURCE, OWNER_B], 2, "1");
    const b = buildSafeConfig([SOURCE, OWNER_B, OWNER_C], 2, "1");
    expect(a).toEqual(b);
    expect(sortOwners([OWNER_C, SOURCE])).toEqual([SOURCE, OWNER_C]);
    expect(safeConfigHash(a)).toBe(safeConfigHash(b));
  });

  it("derives a stable salt per source wallet and variant", () => {
    expect(deriveSaltNonce(SOURCE)).toBe(deriveSaltNonce(SOURCE));
    expect(deriveSaltNonce(SOURCE, 1)).not.toBe(deriveSaltNonce(SOURCE));
    expect(deriveSaltNonce(OWNER_B)).not.toBe(deriveSaltNonce(SOURCE));
  });

  it("binds the config hash to owners, threshold and salt", () => {
    expect(safeConfigHash({ ...CONFIG, threshold: 3 })).not.toBe(safeConfigHash(CONFIG));
    expect(safeConfigHash({ ...CONFIG, saltNonce: "7" })).not.toBe(safeConfigHash(CONFIG));
  });

  it("refuses duplicate owners at build time", () => {
    expect(() => buildSafeConfig([SOURCE, SOURCE, OWNER_B], 2, "1")).toThrow();
  });

  it("warns when the source wallet stays an owner and when owners are unverified", () => {
    const w = signerWarnings([slot(0, SOURCE), slot(1, OWNER_B), slot(2, OWNER_C)], SOURCE, 2);
    expect(w.some((x) => x.message.includes("remain a Safe owner"))).toBe(true);
    expect(w.some((x) => x.message.includes("0 of 3 owners verified"))).toBe(true);
  });
});

describe("owner verification challenge", () => {
  // Local EIP-1193 stub: chainId + "no code" for every address. Signature checks are pure ecrecover.
  const client = createPublicClient({
    chain: sepolia,
    transport: custom({
      async request({ method }: { method: string }) {
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_getCode") return "0x";
        if (method === "eth_call") throw new Error("no contract");
        throw new Error(`unexpected ${method}`);
      },
    }),
  });

  async function signed(account = privateKeyToAccount(generatePrivateKey()), now = Date.now()) {
    const challenge = createChallenge(account.address, safeConfigHash(CONFIG), sepolia.id, now);
    const signature = (await account.signTypedData(challengeTypedData(challenge))) as Hex;
    return { account, challenge, signature };
  }

  it("verifies a real EIP-712 signature from the owner", async () => {
    const { challenge, signature } = await signed();
    const res = await verifyChallengeSignature({ challenge, signature, client, usedNonces: new Set() });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verification.signerType).toBe("eoa");
  });

  it("rejects a signature from a different key", async () => {
    const { challenge } = await signed();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = (await other.signTypedData(challengeTypedData(challenge))) as Hex;
    const res = await verifyChallengeSignature({ challenge, signature, client, usedNonces: new Set() });
    expect(res.ok).toBe(false);
  });

  it("rejects replayed and expired challenges", async () => {
    const { challenge, signature } = await signed();
    expect((await verifyChallengeSignature({ challenge, signature, client, usedNonces: new Set([challenge.nonce]) })).ok).toBe(false);
    const late = challenge.issuedAt + CHALLENGE_TTL_MS + 1;
    expect((await verifyChallengeSignature({ challenge, signature, client, usedNonces: new Set(), now: late })).ok).toBe(false);
  });

  it("rejects challenges bound to another chain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = createChallenge(account.address, safeConfigHash(CONFIG), 1);
    const signature = (await account.signTypedData(challengeTypedData(challenge))) as Hex;
    expect((await verifyChallengeSignature({ challenge, signature, client, usedNonces: new Set() })).ok).toBe(false);
  });
});
