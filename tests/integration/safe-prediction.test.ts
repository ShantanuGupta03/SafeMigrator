/**
 * Live-network checks (read-only). Run with: RUN_NETWORK_TESTS=1 npx vitest run tests/integration
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { getPublicClient } from "@/lib/chains/clients";
import {
  buildDeploymentTransaction,
  negotiateSafeVersion,
  predictSafe,
  resolveChainTarget,
} from "@/lib/services/safe-deployment";
import { buildSafeConfig, deriveSaltNonce } from "@/lib/services/signer-configuration";

const run = process.env.RUN_NETWORK_TESTS === "1";
const SEPOLIA = 11155111;
const CHIADO = 10200;
const BASE_SEPOLIA = 84532;
const TESTNETS = [SEPOLIA, CHIADO, BASE_SEPOLIA];

const config = buildSafeConfig(
  [
    getAddress("0x1111111111111111111111111111111111111111"),
    getAddress("0x2222222222222222222222222222222222222222"),
    getAddress("0x3333333333333333333333333333333333333333"),
  ],
  2,
  deriveSaltNonce(getAddress("0x1111111111111111111111111111111111111111")),
);

describe.runIf(run)("live Safe prediction (Sepolia + Chiado + Base Sepolia)", () => {
  it("negotiates v1.3.0 and predicts the same address on every testnet", async () => {
    const negotiation = await negotiateSafeVersion(TESTNETS, getPublicClient);
    expect(negotiation.commonVersion).toBe("1.3.0");

    const predictions = await Promise.all(
      TESTNETS.map((id) => {
        const c = negotiation.perChain[id]!;
        return predictSafe(id, getPublicClient(id), config, c.version!, c.contracts!);
      }),
    );
    for (const p of predictions) expect(p.issues).toEqual([]);
    expect(new Set(predictions.map((p) => p.sdkAddress)).size).toBe(1);

    const sep = negotiation.perChain[SEPOLIA]!;
    const tx = await buildDeploymentTransaction(SEPOLIA, getPublicClient(SEPOLIA), config, sep.version!, sep.contracts!);
    expect(tx.to).toBe(sep.contracts!.proxyFactory);

    const target = await resolveChainTarget(SEPOLIA, getPublicClient(SEPOLIA), config, sep);
    expect(target.predictedAddress).toBe(predictions[0]!.sdkAddress);
    expect(target.status).toBe("not_deployed");
  }, 60_000);

  it("uses v1.4.1 on networks that carry it canonically", async () => {
    expect((await negotiateSafeVersion([SEPOLIA], getPublicClient)).commonVersion).toBe("1.4.1");
    expect((await negotiateSafeVersion([SEPOLIA, BASE_SEPOLIA], getPublicClient)).commonVersion).toBe("1.4.1");
  }, 60_000);
});
