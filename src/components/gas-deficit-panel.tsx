"use client";

import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getChain, executionGate } from "@/lib/chains/registry";
import { formatAmount, toBigInt } from "@/lib/domain/amounts";
import { chainRetention, extraRetainAmount, type GasRetentionPrefs } from "@/lib/domain/gas-retention";
import type { ChainPlan } from "@/lib/services/migration-planning";
import type { Address } from "viem";
import { AddressChip } from "./shared";

export interface GasDeficitRow {
  chainId: number;
  plan: ChainPlan;
  gasRetention?: GasRetentionPrefs;
  quotedAt: number;
}

export function GasDeficitPanel(props: {
  source: Address;
  environment: "testnet" | "mainnet";
  rows: GasDeficitRow[];
  onRecheck?(): void;
  rechecking?: boolean;
}) {
  const deficits = props.rows.filter((r) => r.plan.deficit > 0n || r.plan.blockers.some((b) => /Insufficient/i.test(b)));
  if (!deficits.length) return null;

  return (
    <div className="space-y-4">
      {deficits.map(({ chainId, plan, gasRetention, quotedAt }) => {
        const meta = getChain(chainId);
        const nativeAction = plan.actions.find((a) => a.kind === "transfer_native" && a.status === "planned");
        const extra = extraRetainAmount(gasRetention, chainId);
        const retention = chainRetention(gasRetention, chainId);
        return (
          <Alert key={chainId} variant="warning" title={`${meta.name}: not enough ${meta.nativeSymbol} for execution`}>
            <GasDeficitBody
              source={props.source}
              chainId={chainId}
              environment={props.environment}
              nativeBalance={plan.nativeBalance}
              nativeTransfer={nativeAction ? toBigInt(nativeAction.amounts[0] ?? "0") : null}
              reserve={plan.nativeReserve}
              extraRetain={extra}
              extraEnabled={retention.enabled}
              deficit={plan.deficit}
              quotedAt={quotedAt}
            />
          </Alert>
        );
      })}
      {props.onRecheck && (
        <Button variant="outline" size="sm" onClick={props.onRecheck} disabled={props.rechecking}>
          <RefreshCw className={props.rechecking ? "animate-spin" : ""} /> I added funds — recheck
        </Button>
      )}
      <p className="text-xs text-muted-foreground">Top up the source wallet that pays migration gas, not the destination Safe. Amounts and destination stay in your draft while you recheck.</p>
    </div>
  );
}

function GasDeficitBody(props: {
  source: Address;
  chainId: number;
  environment: "testnet" | "mainnet";
  nativeBalance: bigint | null;
  nativeTransfer: bigint | null;
  reserve: bigint;
  extraRetain: bigint;
  extraEnabled: boolean;
  deficit: bigint;
  quotedAt: number;
}) {
  const meta = getChain(props.chainId);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(props.source);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const faucet =
    props.environment === "testnet"
      ? meta.name.includes("Sepolia")
        ? "https://sepoliafaucet.com/"
        : meta.name.includes("Chiado")
          ? "https://faucet.gnosischain.com/"
          : meta.name.includes("Base")
            ? "https://www.coinbase.com/faucets/base-sepolia-faucet"
            : null
      : null;

  return (
    <div className="mt-2 space-y-2 text-sm">
      <p>
        Source (pays gas): <AddressChip address={props.source} chainId={props.chainId} className="bg-card" />
        <Button type="button" variant="ghost" size="sm" className="ml-1 h-7" onClick={() => void copy()}>
          <Copy className="size-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      </p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          Balance now: {props.nativeBalance !== null ? `${formatAmount(props.nativeBalance, meta.nativeDecimals)} ${meta.nativeSymbol}` : "unknown"}
        </li>
        {props.nativeTransfer !== null && (
          <li>
            Selected native transfer: {formatAmount(props.nativeTransfer, meta.nativeDecimals)} {meta.nativeSymbol}
          </li>
        )}
        <li>
          Estimated remaining migration cost (reserved): up to {formatAmount(props.reserve, meta.nativeDecimals)} {meta.nativeSymbol}
        </li>
        <li>
          Optional extra retain: {props.extraEnabled ? formatAmount(props.extraRetain, meta.nativeDecimals) : "off"} {meta.nativeSymbol}
        </li>
        {props.deficit > 0n && (
          <li className="font-medium text-foreground">
            Shortfall: at least {formatAmount(props.deficit, meta.nativeDecimals)} {meta.nativeSymbol}
          </li>
        )}
        <li>Quote checked: {new Date(props.quotedAt).toLocaleString()}</li>
      </ul>
      {!executionGate(props.chainId).enabled && props.environment === "mainnet" && (
        <p className="text-xs">Production execution is gated in this build; funding alone does not enable migration.</p>
      )}
      {faucet && (
        <p className="text-xs">
          Testnet faucet:{" "}
          <a href={faucet} target="_blank" rel="noreferrer" className="underline">
            {faucet}
          </a>
        </p>
      )}
    </div>
  );
}
