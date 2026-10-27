"use client";

import { BadgeCheck, Copy, Download, FileUp, Loader2, ShieldAlert, ShieldCheck, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { useConfig, useConnect, useConnection, useConnectors } from "wagmi";
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
  checkInvitePayload,
  decodeInviteFragment,
  verifyInviteAddress,
  type InvitePayload,
} from "@/lib/services/owner-invites";
import { errorMessage, isUserRejection } from "@/lib/services/wallet-connection";
import { useIsClient } from "../hooks/use-is-client";
import { AddressChip, ChainLabel, downloadFile, readFileText, ScreenHeading } from "../shared";

type Loaded = { payload: InvitePayload; config: SafeConfig; warnings: string[] };

/**
 * Co-owner side of remote verification. Opens an invitation from the URL fragment (or a file),
 * re-derives everything it shows, and lets the invited owner sign an acknowledgement. It never sends
 * a transaction and never contacts the initiator: the signed response is copied or downloaded and
 * returned by the owner through a channel they choose.
 */
export function InviteScreen() {
  const isClient = useIsClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<{ status: "checking" | "match" | "mismatch" | "unavailable"; detail: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const accept = (raw: unknown) => {
    const check = checkInvitePayload(raw);
    if (!check.ok) {
      setLoaded(null);
      setError(check.reason);
      return;
    }
    setError(null);
    setLoaded(check);
    setAddress({ status: "checking", detail: "Recomputing the Safe address from the official contracts…" });
    void verifyInviteAddress(check.payload, check.config, getPublicClient).then(setAddress);
  };

  useEffect(() => {
    if (!isClient || !window.location.hash) return;
    decodeInviteFragment(window.location.hash)
      .then(accept)
      .catch((e: Error) => setError(e.message));
  }, [isClient]);

  const expired = !!loaded && now > loaded.payload.expiresAt;

  return (
    <div className="space-y-8">
      <ScreenHeading
        title="You have been asked to confirm Safe ownership."
        subtitle="Someone is setting up a multisig Safe and listed one of your addresses as an owner. Review it, then sign an acknowledgement. Signing moves no funds and authorizes no transaction."
      />

      <Alert variant="warning" title="A link does not prove who sent it">
        Before signing, confirm with the person who sent this, through a channel you already trust, that the owners, threshold and Safe address below are what they intend.
      </Alert>

      {!loaded && (
        <Card>
          <CardContent className="space-y-3 p-6">
            {error ? <Alert variant="danger" title="This invitation cannot be used">{error}</Alert> : <p className="text-sm text-muted-foreground">No invitation found in this link.</p>}
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <FileUp /> Open an invitation file
            </Button>
          </CardContent>
        </Card>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            accept(JSON.parse(await readFileText(f, 32 * 1024)));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />

      {loaded && <InviteDetails loaded={loaded} address={address} expired={expired} />}
      {loaded && !expired && <SignPanel loaded={loaded} addressOk={address?.status === "match"} />}
      {loaded && expired && <Alert variant="danger" title="This invitation has expired">Ask the sender for a new link.</Alert>}
    </div>
  );
}

function InviteDetails({ loaded, address, expired }: { loaded: Loaded; address: { status: string; detail: string } | null; expired: boolean }) {
  const p = loaded.payload;
  return (
    <Card>
      <CardHeader>
        <p className="font-medium">What you are acknowledging</p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Your address (the invited owner)">
            <AddressChip address={p.owner} full />
          </Field>
          <Field label="Safe address">
            <AddressChip address={p.safe} full />
            <p className="mt-1 flex items-center gap-1 text-xs">
              {address?.status === "match" ? (
                <>
                  <ShieldCheck className="size-3.5 text-success-foreground" /> {address.detail}
                </>
              ) : address?.status === "checking" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> {address.detail}
                </>
              ) : (
                <span className="flex items-center gap-1 text-destructive">
                  <ShieldAlert className="size-3.5" /> {address?.detail}
                </span>
              )}
            </p>
          </Field>
          <Field label={`All ${p.owners.length} owners`}>
            <div className="flex flex-wrap gap-1">
              {p.owners.map((o) => (
                <AddressChip key={o} address={o} className={o === p.owner ? "ring-1 ring-safe-black" : undefined} />
              ))}
            </div>
          </Field>
          <Field label="Signatures required">
            <p className="font-medium">
              {p.threshold} of {p.owners.length}
            </p>
            {loaded.warnings.map((w) => (
              <p key={w} className="text-xs text-warning-foreground">
                {w}
              </p>
            ))}
          </Field>
          <Field label="Migrating from (source wallet)">
            <AddressChip address={p.source} />
          </Field>
          <Field label="Environment and networks">
            <Badge variant={p.environment === "testnet" ? "default" : "warning"}>{p.environment === "testnet" ? "Testnets" : "Production networks"}</Badge>
            <div className="mt-1 flex flex-wrap gap-2">
              {p.chainIds.map((id) => (
                <ChainLabel key={id} chainId={id} />
              ))}
            </div>
          </Field>
          <Field label="Deployment">
            <p>
              Safe v{p.recipe.safeVersion}, official contracts. Commitment <span className="font-mono text-xs">{p.commitment.slice(0, 18)}…</span> (recomputed on this device)
            </p>
          </Field>
          <Field label="Invitation window">
            <p className={expired ? "text-destructive" : undefined}>
              Issued {new Date(p.issuedAt).toLocaleString()}, expires {new Date(p.expiresAt).toLocaleString()}
            </p>
          </Field>
        </div>
        <Alert variant="info" title="What signing does">
          It proves you control {p.owner.slice(0, 8)}… and that you accept being an owner of this exact Safe. It is an off-chain message: no gas, no transaction, no approval, and
          it can never be used to move funds.
        </Alert>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 rounded-xl bg-muted p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function SignPanel({ loaded, addressOk }: { loaded: Loaded; addressOk: boolean }) {
  const p = loaded.payload;
  const isClient = useIsClient();
  const wagmiConfig = useConfig();
  const { address, chainId: walletChain, isConnected } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const [picked, setChainId] = useState<number | null>(null);
  const chainId = picked ?? (walletChain && p.chainIds.includes(walletChain) ? walletChain : p.chainIds[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rightAccount = !!address && address.toLowerCase() === p.owner.toLowerCase();

  const sign = async () => {
    if (!address) return;
    setError(null);
    setBusy(true);
    try {
      if ((await getChainId(wagmiConfig)) !== chainId) await switchChain(wagmiConfig, { chainId });
      const signature = (await signTypedData(wagmiConfig, { account: address, ...acknowledgementTypedData(p, chainId) })) as Hex;
      setResponse(buildResponse(p, chainId, signature));
    } catch (e) {
      setError(isUserRejection(e) ? "You rejected the signature request. Nothing was signed." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (response) {
    return (
      <Card className="ring-2 ring-labs-green">
        <CardHeader>
          <p className="flex items-center gap-2 font-medium">
            <BadgeCheck className="size-4" /> Signed. Now send the response back
          </p>
          <p className="text-sm text-muted-foreground">
            Copy this response, or download it, and send it to the person who invited you. They paste it into Safe Migrator. Nothing is sent automatically. It is valid only for
            their invitation and only until it expires on {new Date(p.expiresAt).toLocaleString()}.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea readOnly className="min-h-40 w-full rounded-xl border border-border bg-muted p-2 font-mono text-xs" value={response} aria-label="Signed response" />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(response);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy /> {copied ? "Copied" : "Copy response"}
            </Button>
            <Button variant="outline" onClick={() => downloadFile(`safe-owner-response-${p.owner.slice(2, 8)}.json`, response)}>
              <Download /> Download response
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <p className="flex items-center gap-2 font-medium">
          <Wallet className="size-4" /> Sign with {p.owner.slice(0, 8)}…{p.owner.slice(-4)}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!isConnected ? (
          <div className="flex flex-wrap gap-2">
            {(isClient ? connectors : []).map((c) => (
              <Button key={c.uid} variant="outline" disabled={isPending} onClick={() => connect({ connector: c })}>
                {isPending ? <Loader2 className="animate-spin" /> : <Wallet />} {c.name}
              </Button>
            ))}
            {isClient && connectors.length === 0 && <p className="text-muted-foreground">No browser wallet detected.</p>}
          </div>
        ) : (
          <p>
            Connected as <span className="font-mono">{address}</span>
          </p>
        )}
        {isConnected && !rightAccount && (
          <Alert variant="warning">Switch your wallet to the invited address {p.owner}. A signature from another account would be rejected by the initiator.</Alert>
        )}
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Sign on network</span>
          <Select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} aria-label="Signing network">
            {p.chainIds.map((id) => (
              <option key={id} value={id}>
                {getChain(id).name}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">Contract wallets (for example another Safe) are checked on the network you sign on.</span>
        </label>
        {!addressOk && (
          <Alert variant="warning">The Safe address has not been independently recomputed on this device yet. Signing stays disabled until it matches.</Alert>
        )}
        <Button disabled={!rightAccount || !addressOk || busy} onClick={() => void sign()}>
          {busy ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Sign acknowledgement
        </Button>
        {error && <Alert variant="danger">{error}</Alert>}
      </CardContent>
    </Card>
  );
}
