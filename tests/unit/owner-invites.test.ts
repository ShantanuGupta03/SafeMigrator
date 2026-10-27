/**
 * Remote co-owner verification. Two "devices" are simulated: the initiator keeps its invitation
 * records, the co-owner only ever sees the link. Signatures are real (viem accounts); the RPC is a
 * local stub that reports no contract code, so EOA signatures are checked by ecrecover.
 */
import { createPublicClient, custom, getAddress, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { getChain } from "@/lib/chains/registry";
import type { SafeProfile } from "@/lib/domain/profile";
import type { SignerSlot } from "@/lib/domain/types";
import {
  acknowledgementTypedData,
  ACCEPTED_PROOF_MAX_AGE_MS,
  buildResponse,
  checkInvitePayload,
  createInvite,
  decodeInviteFragment,
  encodeInviteFragment,
  importInviteResponse,
  inviteState,
  payloadFor,
  reverifyAcknowledgement,
  verificationFromInvite,
  type InvitePayload,
  type OwnerInvite,
} from "@/lib/services/owner-invites";
import { validateOwnerReadiness } from "@/lib/services/owner-readiness";
import { buildRecipe, createProfile } from "@/lib/services/safe-profile";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";
import { loadInvites, saveInvites } from "@/lib/state/profile-store";
import { memoryStore } from "@/lib/state/persistence";

const SEPOLIA = 11155111;
const CHIADO = 10200;
const CODE = "0x608060405234801561001057600080fd5b50" as Hex;

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());

const config = buildSafeConfig([alice.address, bob.address, carol.address], 2, deriveSaltNonce(alice.address));
const NOW = 1_800_000_000_000;

function makeProfile(cfg = config, environment: "testnet" | "mainnet" = "testnet"): SafeProfile {
  return createProfile({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", source: alice.address, environment, config: cfg, recipe: buildRecipe(cfg, environment === "testnet" ? "1.3.0" : "1.4.1", CODE), status: "proposed", now: NOW });
}

const clients = new Map<number, PublicClient>();
function clientFor(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({
      chain: getChain(chainId).viemChain,
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
          if (method === "eth_getCode") return "0x";
          if (method === "eth_call") throw new Error("no contract");
          throw new Error(`unexpected ${method}`);
        },
      }),
    }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

/** Co-owner device: receives only the link fragment. */
async function coOwnerSigns(fragment: string, signer = bob, chainId = CHIADO, now = NOW + 60_000) {
  const decoded = await decodeInviteFragment(fragment);
  const check = checkInvitePayload(decoded, now);
  if (!check.ok) throw new Error(check.reason);
  const signature = (await signer.signTypedData(acknowledgementTypedData(check.payload, chainId))) as Hex;
  return buildResponse(check.payload, chainId, signature);
}

async function issue(owner = bob.address, ttlMs?: number) {
  const profile = makeProfile();
  const invite = createInvite({ profile, owner, chainIds: [SEPOLIA, CHIADO], ttlMs, now: NOW });
  const fragment = await encodeInviteFragment(payloadFor(profile, invite));
  return { profile, invite, fragment };
}

describe("invitation link", () => {
  it("round-trips through a compact URL fragment", async () => {
    const { profile, invite, fragment } = await issue();
    expect(fragment.length).toBeLessThan(1800);
    expect(await decodeInviteFragment(`#${fragment}`)).toEqual(payloadFor(profile, invite));
  });

  it("recomputes the commitment instead of trusting the link", async () => {
    const { profile, invite } = await issue();
    const p = payloadFor(profile, invite);
    expect(checkInvitePayload(p, NOW).ok).toBe(true);
    expect(checkInvitePayload({ ...p, threshold: 1 }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/commitment/) });
    expect(checkInvitePayload({ ...p, owners: [alice.address, bob.address, mallory.address].sort() }, NOW).ok).toBe(false);
    expect(checkInvitePayload({ ...p, recipe: { ...p.recipe, singleton: mallory.address } }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/official/) });
    expect(checkInvitePayload({ ...p, owner: mallory.address }, NOW).ok).toBe(false);
  });

  it("rejects expired, future-dated and over-long invitations on the co-owner device", async () => {
    const { profile, invite } = await issue();
    const p = payloadFor(profile, invite);
    expect(checkInvitePayload(p, p.expiresAt + 1).ok).toBe(false);
    expect(checkInvitePayload(p, NOW - 10 * 60_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
    expect(checkInvitePayload({ ...p, expiresAt: p.issuedAt + 100 * 3600_000 }, NOW).ok).toBe(false);
  });
});

describe("signed response import (initiator)", () => {
  it("verifies a co-owner proof end to end and records which network it was signed on", async () => {
    const { profile, invite, fragment } = await issue();
    const response = await coOwnerSigns(fragment);
    const r = await importInviteResponse({ text: response, invites: [invite], profile, clientFor, now: NOW + 120_000 });
    expect(r).toMatchObject({ ok: true, duplicate: false, invite: { status: "verified", proof: { chainId: CHIADO, signerType: "eoa" } } });
    if (r.ok) expect(inviteState(r.invite, profile, NOW + 120_000)).toBe("verified");
  });

  it("is idempotent: importing the same response twice never adds a second verification", async () => {
    const { profile, invite, fragment } = await issue();
    const response = await coOwnerSigns(fragment);
    const first = await importInviteResponse({ text: response, invites: [invite], profile, clientFor, now: NOW + 1000 });
    if (!first.ok) throw new Error(first.reason);
    const again = await importInviteResponse({ text: response, invites: [first.invite], profile, clientFor, now: NOW + 2000 });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    if (again.ok) expect(again.invite).toEqual(first.invite);
  });

  it("rejects a signature from the wrong owner", async () => {
    const { profile, invite, fragment } = await issue();
    const r = await importInviteResponse({ text: await coOwnerSigns(fragment, mallory), invites: [invite], profile, clientFor, now: NOW + 1000 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not made by the invited owner/) });
  });

  it("rejects an altered response payload even when re-signed", async () => {
    const { profile, invite } = await issue();
    const altered: InvitePayload = { ...payloadFor(profile, invite), expiresAt: invite.expiresAt + 3600_000 };
    const signature = (await bob.signTypedData(acknowledgementTypedData(altered, CHIADO))) as Hex;
    const r = await importInviteResponse({ text: buildResponse(altered, CHIADO, signature), invites: [invite], profile, clientFor, now: NOW + 1000 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match the invitation/) });
  });

  it("rejects a valid signature for an invitation this workspace never issued", async () => {
    const { profile, fragment } = await issue();
    const r = await importInviteResponse({ text: await coOwnerSigns(fragment), invites: [], profile, clientFor, now: NOW + 1000 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/did not issue/) });
  });

  it("rejects revoked and expired invitations", async () => {
    const { profile, invite, fragment } = await issue(bob.address, 3600_000);
    const response = await coOwnerSigns(fragment);
    expect((await importInviteResponse({ text: response, invites: [{ ...invite, status: "revoked" }], profile, clientFor, now: NOW + 1000 })).ok).toBe(false);
    const late = await importInviteResponse({ text: response, invites: [invite], profile, clientFor, now: invite.expiresAt + 1 });
    expect(late).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(inviteState(invite, profile, invite.expiresAt + 1)).toBe("expired");
  });

  it("rejects a network outside the invitation's scope", async () => {
    const { profile, invite, fragment } = await issue();
    const decoded = checkInvitePayload(await decodeInviteFragment(fragment), NOW);
    if (!decoded.ok) throw new Error(decoded.reason);
    const sig = (await bob.signTypedData(acknowledgementTypedData(decoded.payload, 84532))) as Hex;
    const r = await importInviteResponse({ text: buildResponse(decoded.payload, 84532, sig), invites: [invite], profile, clientFor, now: NOW + 1000 });
    expect(r.ok).toBe(false);
  });

  it("invalidates pending invitations and proofs when the configuration changes", async () => {
    const { invite, fragment } = await issue();
    const changed = makeProfile(buildSafeConfig([alice.address, bob.address, carol.address], 3, config.saltNonce));
    expect(inviteState(invite, changed, NOW)).toBe("invalidated");
    const r = await importInviteResponse({ text: await coOwnerSigns(fragment), invites: [invite], profile: changed, clientFor, now: NOW + 1000 });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses garbage and oversized input", async () => {
    const { profile, invite } = await issue();
    expect((await importInviteResponse({ text: "{", invites: [invite], profile, clientFor })).ok).toBe(false);
    expect((await importInviteResponse({ text: "x".repeat(20_000), invites: [invite], profile, clientFor })).ok).toBe(false);
    expect((await importInviteResponse({ text: '{"v":1}', invites: [invite], profile, clientFor })).ok).toBe(false);
  });

  it("only issues invitations to owners of a pinned configuration", () => {
    expect(() => createInvite({ profile: makeProfile(), owner: mallory.address, chainIds: [SEPOLIA] })).toThrow(/not an owner/);
    expect(() => createInvite({ profile: makeProfile(), owner: bob.address, chainIds: [1] })).toThrow(/environment/);
    expect(() => createInvite({ profile: makeProfile(), owner: bob.address, chainIds: [SEPOLIA], ttlMs: 100 * 3600_000 })).toThrow(/72 hours/);
  });

  it("persists invitations and drops corrupted entries", async () => {
    const { invite } = await issue();
    const store = memoryStore();
    saveInvites(store, alice.address, [invite, { ...invite, nonce: "0x1234" } as unknown as OwnerInvite]);
    expect(loadInvites(store, alice.address)).toEqual([invite]);
  });
});

describe("execution-time re-verification", () => {
  async function verifiedSlot(signerChain = CHIADO, signerType: "eoa" | "contract" = "eoa") {
    const { profile, invite, fragment } = await issue();
    const r = await importInviteResponse({ text: await coOwnerSigns(fragment, bob, signerChain), invites: [invite], profile, clientFor, now: NOW + 1000 });
    if (!r.ok) throw new Error(r.reason);
    const v = { ...verificationFromInvite(r.invite, profile), signerType };
    const slot: SignerSlot = { slot: 1, input: bob.address, address: getAddress(bob.address), ensName: null, kind: "independent_wallet", label: "Bob", verification: v };
    return { profile, slot };
  }

  it("checks a proof with a client for its own network, whichever network executes", async () => {
    const { profile, slot } = await verifiedSlot(CHIADO);
    const r = await validateOwnerReadiness({ config, deploymentCommitment: profile.commitment, signers: [slot], clientFor, chainId: SEPOLIA, environment: "testnet", now: NOW + 5000 });
    expect(r.issues).toEqual([]);
    expect(r.verifiedOwners).toEqual([getAddress(bob.address)]);
  });

  it("counts a contract-wallet proof only on the network it was verified on", async () => {
    const { profile, slot } = await verifiedSlot(CHIADO, "contract");
    const onSepolia = await validateOwnerReadiness({ config, deploymentCommitment: profile.commitment, signers: [slot], clientFor, chainId: SEPOLIA, environment: "testnet", now: NOW + 5000 });
    expect(onSepolia.verifiedOwners).toEqual([]);
    expect(onSepolia.issues.join(" ")).toMatch(/contract wallet verified on Gnosis Chiado only/);
    const onChiado = await validateOwnerReadiness({ config, deploymentCommitment: profile.commitment, signers: [slot], clientFor, chainId: CHIADO, environment: "testnet", now: NOW + 5000 });
    expect(onChiado.verifiedOwners).toHaveLength(1);
  });

  it("rejects a proof for another commitment, a tampered signature or an old proof", async () => {
    const { profile, slot } = await verifiedSlot();
    const v = slot.verification!;
    const base = { owner: bob.address, config, clientFor, now: NOW + 5000 };
    expect(await reverifyAcknowledgement({ ...base, verification: v, deploymentCommitment: profile.commitment! })).toEqual({ ok: true });
    expect((await reverifyAcknowledgement({ ...base, verification: v, deploymentCommitment: `0x${"11".repeat(32)}` })).ok).toBe(false);
    expect((await reverifyAcknowledgement({ ...base, verification: { ...v, nonce: `0x${"22".repeat(32)}` }, deploymentCommitment: profile.commitment! })).ok).toBe(false);
    expect((await reverifyAcknowledgement({ ...base, verification: v, deploymentCommitment: profile.commitment!, now: v.issuedAt + ACCEPTED_PROOF_MAX_AGE_MS + 1 })).ok).toBe(false);
  });

  it("never treats a legacy proof list as enough on a gated production network", async () => {
    const { profile, slot } = await verifiedSlot();
    const r = await validateOwnerReadiness({ config, deploymentCommitment: profile.commitment, signers: [slot], clientFor, chainId: 1, environment: "mainnet", now: NOW + 5000 });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/requires 2 cryptographically verified owners/);
  });
});
