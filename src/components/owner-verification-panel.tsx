"use client";

import { BadgeCheck, Ban, Copy, Download, Link2, Loader2, Lock, QrCode, Upload } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { useConfig, useConnection } from "wagmi";
import { getChainId, signTypedData, switchChain } from "wagmi/actions";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { getPublicClient } from "@/lib/chains/clients";
import { getChain } from "@/lib/chains/registry";
import type { SafeConfig } from "@/lib/domain/types";
import {
  acknowledgementTypedData,
  buildResponse,
  createInvite,
  encodeInviteFragment,
  importInviteResponse,
  INVITE_TTL_CHOICES_MS,
  INVITE_TTL_MS,
  inviteFile,
  inviteState,
  payloadFor,
  QR_PRACTICAL_MAX_CHARS,
  RESPONSE_MAX_BYTES,
  verificationFromInvite,
  type InviteState,
  type OwnerInvite,
} from "@/lib/services/owner-invites";
import { chooseProfileForRun, pinRecipe } from "@/lib/services/safe-profile";
import { errorMessage, isUserRejection } from "@/lib/services/wallet-connection";
import { shortAddress } from "@/lib/utils";
import { useAppState } from "./app-state";
import { usePinnedProfile } from "./hooks/use-safe-config";
import { AddressChip, downloadFile, readFileText } from "./shared";

const STATE_BADGE: Record<InviteState | "none", { label: string; variant: "success" | "warning" | "danger" | "outline" | "info" }> = {
  verified: { label: "Verified", variant: "success" },
  awaiting: { label: "Awaiting response", variant: "warning" },
  expired: { label: "Expired", variant: "danger" },
  revoked: { label: "Revoked", variant: "outline" },
  invalidated: { label: "Invalid (configuration changed)", variant: "danger" },
  none: { label: "Not verified", variant: "outline" },
};

const ttlLabel = (ms: number) => (ms < 24 * 3600_000 ? `${ms / 3600_000} hour` : `${ms / (24 * 3600_000)} day${ms > 24 * 3600_000 ? "s" : ""}`);

/**
 * Owner verification for the Signers step. The configuration is frozen first (its deployment recipe
 * is pinned), then each owner proves control either with the connected wallet or remotely through
 * an invitation link and a signed response pasted back here. No transport server is involved.
 */
export function OwnerVerificationPanel({ config, commonVersion, scopeChainIds, targetsReady }: { config: SafeConfig | null; commonVersion: string | null; scopeChainIds: number[]; targetsReady: boolean }) {
  const { draft, setDraft, profiles, saveProfile, source, invites, setInvites } = useAppState();
  const pinned = usePinnedProfile();
  const wagmiConfig = useConfig();
  const { address: connected } = useConnection();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ variant: "success" | "danger" | "info"; text: string } | null>(null);
  const [openInvite, setOpenInvite] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number>(INVITE_TTL_MS);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const latestFor = (owner: Address) =>
    pinned
      ? [...invites].filter((i) => i.profileId === pinned.id && i.owner === owner && i.commitment === pinned.commitment).sort((a, b) => b.createdAt - a.createdAt)[0]
      : undefined;

  const freeze = async () => {
    if (!config || !source) return;
    setMessage(null);
    if (!commonVersion) return setMessage({ variant: "danger", text: "No shared Safe version is available yet, so the configuration cannot be frozen." });
    setBusy("freeze");
    try {
      const chainId = scopeChainIds[0]!;
      const pin = await pinRecipe(getPublicClient(chainId), chainId, config, commonVersion as "1.3.0" | "1.4.1");
      const chosen = chooseProfileForRun({ profiles, source, environment: draft.environment, config, pinned: pin, status: "proposed" });
      saveProfile(chosen.profile, chosen.replaces);
      setDraft((d) => ({ ...d, profileId: chosen.profile.id, saltNonce: chosen.profile.original.saltNonce }));
    } catch (e) {
      setMessage({ variant: "danger", text: `Could not pin the configuration: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const applyVerified = (invite: OwnerInvite) => {
    if (!pinned) return;
    const verification = verificationFromInvite(invite, pinned);
    setInvites((list) => list.map((i) => (i.id === invite.id ? invite : i)));
    setDraft((d) => ({ ...d, signers: d.signers.map((s) => (s.address === invite.owner ? { ...s, verification } : s)) }));
  };

  const verifyConnected = async (owner: Address) => {
    if (!pinned || !connected) return;
    setMessage(null);
    setBusy(`local:${owner}`);
    try {
      const walletChain = await getChainId(wagmiConfig);
      const chainId = scopeChainIds.includes(walletChain) ? walletChain : scopeChainIds[0]!;
      if (walletChain !== chainId) await switchChain(wagmiConfig, { chainId });
      const invite = createInvite({ profile: pinned, owner, chainIds: scopeChainIds, ttlMs: 10 * 60_000 });
      setInvites((list) => [...list, invite]);
      const payload = payloadFor(pinned, invite);
      const signature = await signTypedData(wagmiConfig, { account: connected, ...acknowledgementTypedData(payload, chainId) });
      const r = await importInviteResponse({ text: buildResponse(payload, chainId, signature), invites: [invite], profile: pinned, clientFor: getPublicClient });
      if (!r.ok) return setMessage({ variant: "danger", text: r.reason });
      applyVerified(r.invite);
      setMessage({ variant: "success", text: `${shortAddress(owner)} verified with the connected wallet.` });
    } catch (e) {
      setMessage({ variant: "danger", text: isUserRejection(e) ? "Signature request was rejected." : errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const invite = (owner: Address) => {
    if (!pinned) return;
    const created = createInvite({ profile: pinned, owner, chainIds: scopeChainIds, ttlMs: ttl });
    setInvites((list) => [...list, created]);
    setOpenInvite(created.id);
  };

  const revoke = (inv: OwnerInvite) => {
    setInvites((list) => list.map((i) => (i.id === inv.id ? { ...i, status: "revoked" } : i)));
    setDraft((d) => ({ ...d, signers: d.signers.map((s) => (s.verification?.nonce === inv.nonce ? { ...s, verification: null } : s)) }));
  };

  const importResponse = async (text: string) => {
    setMessage(null);
    setBusy("import");
    try {
      const r = await importInviteResponse({ text, invites, profile: pinned, clientFor: getPublicClient });
      if (!r.ok) return setMessage({ variant: "danger", text: r.reason });
      applyVerified(r.invite);
      setPasted("");
      setMessage({
        variant: r.duplicate ? "info" : "success",
        text: r.duplicate
          ? `This response was already imported; ${shortAddress(r.invite.owner)} stays verified once.`
          : `${shortAddress(r.invite.owner)} verified (signed on ${getChain(r.invite.proof!.chainId).name}${r.invite.proof!.signerType === "contract" ? ", contract wallet" : ""}).`,
      });
    } finally {
      setBusy(null);
    }
  };

  if (!pinned) {
    return (
      <Card>
        <CardHeader>
          <p className="flex items-center gap-2 font-medium">
            <Lock className="size-4" /> Verify owners
          </p>
          <p className="text-sm text-muted-foreground">
            Owners sign an acknowledgement bound to this exact Safe: its owners, threshold, salt and deployment recipe. First freeze the configuration. Changing owners or the
            threshold afterwards invalidates every invitation and proof, and you will need to invite again.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => void freeze()} disabled={!config || !targetsReady || !commonVersion || busy === "freeze"}>
            {busy === "freeze" ? <Loader2 className="animate-spin" /> : <Lock />} Freeze configuration for verification
          </Button>
          {!config && <p className="text-xs text-muted-foreground">Enter every owner first.</p>}
          {message && <Alert variant={message.variant}>{message.text}</Alert>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <p className="flex items-center gap-2 font-medium">
          <BadgeCheck className="size-4" /> Verify owners
        </p>
        <p className="text-sm text-muted-foreground">
          Configuration frozen (commitment <span className="font-mono">{pinned.commitment!.slice(0, 12)}…</span>). Each owner signs an off-chain acknowledgement. It moves no funds
          and authorizes no transaction. Co-owners on another device get a link, sign there, and send you the signed response to paste below. Nothing is relayed through a server.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">New invitations expire after</span>
          <Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} aria-label="Invitation lifetime">
            {INVITE_TTL_CHOICES_MS.map((v) => (
              <option key={v} value={v}>
                {ttlLabel(v)}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">Networks in scope: {scopeChainIds.map((id) => getChain(id).name).join(", ")}</span>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border text-sm">
          {pinned.original.owners.map((owner) => {
            const slot = draft.signers.find((s) => s.address === owner);
            const latest = latestFor(owner);
            const proofCurrent = slot?.verification?.schema === "owner-ack-v2" && slot.verification.deploymentCommitment === pinned.commitment;
            const state: InviteState | "none" = latest ? inviteState(latest, pinned, now) : "none";
            const shown = proofCurrent && state !== "revoked" && state !== "expired" ? "verified" : state === "verified" ? "none" : state;
            const isConnected = !!connected && connected.toLowerCase() === owner.toLowerCase();
            return (
              <div key={owner} className="space-y-2 p-3" data-testid={`owner-row-${owner}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{slot?.label || "Owner"}</span>
                    <AddressChip address={owner} />
                    <Badge variant={STATE_BADGE[shown].variant}>{STATE_BADGE[shown].label}</Badge>
                    {latest && state === "awaiting" && <span className="text-xs text-muted-foreground">expires {new Date(latest.expiresAt).toLocaleString()}</span>}
                    {slot?.verification && !slot.verification.schema && <Badge variant="outline">Legacy proof: verify again</Badge>}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {shown !== "verified" && (
                      <Button size="sm" variant={isConnected ? "default" : "outline"} disabled={!isConnected || !!busy} onClick={() => void verifyConnected(owner)} title={isConnected ? undefined : "Switch your wallet to this account to sign here"}>
                        {busy === `local:${owner}` ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Sign here
                      </Button>
                    )}
                    {shown !== "verified" && (
                      <Button size="sm" variant="outline" onClick={() => invite(owner)}>
                        <Link2 /> Invite
                      </Button>
                    )}
                    {latest && (state === "awaiting" || state === "verified") && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(latest)}>
                        <Ban /> Revoke
                      </Button>
                    )}
                  </span>
                </div>
                {latest && openInvite === latest.id && state === "awaiting" && <InviteShare invite={latest} onClose={() => setOpenInvite(null)} />}
              </div>
            );
          })}
        </div>

        <div className="space-y-2 rounded-xl bg-muted p-3">
          <p className="text-sm font-medium">Import a signed response</p>
          <p className="text-xs text-muted-foreground">
            Paste the response a co-owner sent you, or choose the file. It is accepted only for an invitation issued here, before it expires, signed by that owner for this exact
            configuration. Importing the same response twice changes nothing.
          </p>
          <textarea
            className="min-h-24 w-full rounded-xl border border-border bg-card p-2 font-mono text-xs"
            placeholder='{"v":1,"k":"owner-invite-response", …}'
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            aria-label="Signed response"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!pasted.trim() || busy === "import"} onClick={() => void importResponse(pasted)}>
              {busy === "import" ? <Loader2 className="animate-spin" /> : <Upload />} Import response
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload /> Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await importResponse(await readFileText(f, RESPONSE_MAX_BYTES).catch((err: Error) => err.message));
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {message && <Alert variant={message.variant}>{message.text}</Alert>}
        <p className="text-xs text-muted-foreground">
          Invitation records and used nonces are kept in this browser only. They protect this workspace against replays; they are not a global registry.
        </p>
      </CardContent>
    </Card>
  );
}

function InviteShare({ invite, onClose }: { invite: OwnerInvite; onClose(): void }) {
  const { profiles } = useAppState();
  const profile = profiles.find((p) => p.id === invite.profileId) ?? null;
  const payload = useMemo(() => (profile ? payloadFor(profile, invite) : null), [profile, invite]);
  const [url, setUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!payload) return;
    let cancelled = false;
    void (async () => {
      const link = `${window.location.origin}/invite#${await encodeInviteFragment(payload)}`;
      if (cancelled) return;
      setUrl(link);
      setQr(link.length <= QR_PRACTICAL_MAX_CHARS ? await QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 240 }) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (!payload) return null;
  return (
    <div className="grid gap-3 rounded-xl bg-muted p-3 md:grid-cols-[1fr_auto]">
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          Send this link to the owner through a channel you trust. It contains only public configuration and expires {new Date(invite.expiresAt).toLocaleString()}. Ask them to
          confirm the owner list with you directly: a link alone does not prove who sent it.
        </p>
        <p className="break-all rounded-lg bg-card p-2 font-mono text-[11px]" data-testid="invite-link">
          {url ?? "…"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!url}
            onClick={() => {
              void navigator.clipboard?.writeText(url!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy /> {copied ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`safe-owner-invitation-${invite.owner.slice(2, 8)}.json`, inviteFile(payload))}>
            <Download /> Invitation file
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center gap-1">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="QR code of the invitation link" className="size-40 rounded-lg bg-white p-1" />
        ) : (
          <p className="flex max-w-40 items-center gap-1 text-xs text-muted-foreground">
            <QrCode className="size-4 shrink-0" /> Link too long for a reliable QR code; send the invitation file instead.
          </p>
        )}
      </div>
    </div>
  );
}
