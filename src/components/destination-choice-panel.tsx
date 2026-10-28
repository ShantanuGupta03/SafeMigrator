"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MigrationDestination, ProfileDestinationKind } from "@/lib/domain/destination";
import { parseAddressInput } from "@/lib/services/signer-configuration";
import type { SafeConfig } from "@/lib/domain/types";

export function DestinationChoicePanel(props: {
  kind: ProfileDestinationKind;
  existingInput: string;
  config: SafeConfig | null;
  onChange(v: { kind: ProfileDestinationKind; existingInput: string; destination: MigrationDestination | null }): void;
  onLoadOwners?(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const pick = (kind: ProfileDestinationKind) => {
    if (kind === "created") {
      props.onChange({
        kind,
        existingInput: "",
        destination: props.config ? { kind: "new_safe", config: props.config } : null,
      });
      return;
    }
    props.onChange({ kind, existingInput: props.existingInput, destination: null });
  };
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4 text-sm">
      <p className="font-medium">Destination Safe</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`rounded-full border px-3 py-1.5 text-xs ${props.kind === "created" ? "border-primary bg-muted font-medium" : "text-muted-foreground"}`} onClick={() => pick("created")}>
          Create a new Safe
        </button>
        <button
          type="button"
          className={`rounded-full border px-3 py-1.5 text-xs ${props.kind === "imported_existing" ? "border-primary bg-muted font-medium" : "text-muted-foreground"}`}
          onClick={() => pick("imported_existing")}
        >
          Use an existing Safe
        </button>
      </div>
      {props.kind === "imported_existing" && (
        <>
          <Input
            placeholder="Existing Safe address or ENS"
            value={props.existingInput}
            className="font-mono"
            onChange={(e) => {
              setError(null);
              props.onChange({ kind: "imported_existing", existingInput: e.target.value, destination: null });
            }}
            onBlur={() => {
              const addr = parseAddressInput(props.existingInput.trim());
              if (!addr) {
                setError("Enter a valid address.");
                return;
              }
              props.onChange({
                kind: "imported_existing",
                existingInput: props.existingInput,
                destination: { kind: "existing_safe", address: addr },
              });
            }}
          />
          {error && (
            <Alert variant="danger" title="Address">
              {error}
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            Owners, threshold, modules and guard are checked per network before review. Empty addresses are not deployed automatically.
          </p>
          {props.onLoadOwners && (
            <Button type="button" size="sm" variant="outline" onClick={props.onLoadOwners}>
              Load owners from Safe on first selected network
            </Button>
          )}
        </>
      )}
    </div>
  );
}
