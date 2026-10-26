import { concat, encodeFunctionData, getAddress, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { proxyFactoryAbi, safeAbi } from "@/lib/abis";
import { canonicalContracts, computeSafeAddress, encodeSetupInitializer, inspectDeploymentTransaction } from "@/lib/services/safe-deployment";
import { CONFIG, contracts130, OWNER_B } from "./fixtures";

const contracts = contracts130();

function deploymentTx(initializer: Hex = encodeSetupInitializer(CONFIG, contracts.fallbackHandler), overrides: Partial<{ singleton: `0x${string}`; salt: bigint }> = {}) {
  return {
    to: contracts.proxyFactory,
    value: 0n,
    data: encodeFunctionData({
      abi: proxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [overrides.singleton ?? contracts.singleton, initializer, overrides.salt ?? BigInt(CONFIG.saltNonce)],
    }),
  };
}

describe("canonical Safe contracts", () => {
  it("uses the canonical v1.3.0 L2 singleton and factory", () => {
    const c = canonicalContracts("1.3.0");
    expect(c.singleton.address).toBe("0x3E5c63644E683549055b9Be8653de26E0B4CD36E");
    expect(c.proxyFactory.address).toBe("0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2");
  });

  it("has canonical v1.4.1 contracts", () => {
    expect(canonicalContracts("1.4.1").singleton.address).toBe("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
  });
});

describe("deployment transaction inspection", () => {
  it("accepts the expected owners/threshold-only setup", () => {
    expect(inspectDeploymentTransaction(deploymentTx(), CONFIG, contracts)).toEqual([]);
  });

  it("rejects a different factory, value or singleton", () => {
    expect(inspectDeploymentTransaction({ ...deploymentTx(), to: OWNER_B }, CONFIG, contracts)).toContain("Deployment targets an unexpected factory.");
    expect(inspectDeploymentTransaction({ ...deploymentTx(), value: 1n }, CONFIG, contracts)).toContain("Deployment transaction carries value.");
    expect(inspectDeploymentTransaction(deploymentTx(undefined, { singleton: OWNER_B }), CONFIG, contracts)).toContain("Unexpected singleton.");
    expect(inspectDeploymentTransaction(deploymentTx(undefined, { salt: 1n }), CONFIG, contracts)).toContain("Unexpected salt nonce.");
  });

  it("rejects setup with a delegatecall, module or payment", () => {
    const withDelegate = encodeFunctionData({
      abi: safeAbi,
      functionName: "setup",
      args: [CONFIG.owners, 2n, OWNER_B, "0x1234", contracts.fallbackHandler, zeroAddress, 0n, zeroAddress],
    });
    expect(inspectDeploymentTransaction(deploymentTx(withDelegate), CONFIG, contracts).join(" ")).toMatch(/initializer differs/);
    const withPayment = encodeFunctionData({
      abi: safeAbi,
      functionName: "setup",
      args: [CONFIG.owners, 2n, zeroAddress, "0x", contracts.fallbackHandler, zeroAddress, 1n, OWNER_B],
    });
    expect(inspectDeploymentTransaction(deploymentTx(withPayment), CONFIG, contracts).join(" ")).toMatch(/initializer differs/);
  });

  it("rejects trailing calldata and unknown methods", () => {
    const tx = deploymentTx();
    expect(inspectDeploymentTransaction({ ...tx, data: concat([tx.data, "0xdeadbeef"]) }, CONFIG, contracts)).toContain(
      "Deployment calldata has unexpected trailing bytes.",
    );
    expect(inspectDeploymentTransaction({ ...tx, data: "0x12345678" }, CONFIG, contracts).join(" ")).toMatch(/not createProxyWithNonce/);
  });
});

describe("CREATE2 address computation", () => {
  const params = {
    factory: contracts.proxyFactory,
    singleton: contracts.singleton,
    initializer: encodeSetupInitializer(CONFIG, contracts.fallbackHandler),
    saltNonce: BigInt(CONFIG.saltNonce),
    proxyCreationCode: "0x6080" as Hex,
  };

  it("is deterministic and independent of the chain", () => {
    expect(computeSafeAddress(params)).toBe(computeSafeAddress({ ...params }));
    expect(getAddress(computeSafeAddress(params))).toBe(computeSafeAddress(params));
  });

  it("changes with owners, salt, singleton or factory", () => {
    const base = computeSafeAddress(params);
    expect(computeSafeAddress({ ...params, saltNonce: 1n })).not.toBe(base);
    expect(computeSafeAddress({ ...params, singleton: canonicalContracts("1.4.1").singleton.address })).not.toBe(base);
    expect(computeSafeAddress({ ...params, factory: OWNER_B })).not.toBe(base);
    expect(computeSafeAddress({ ...params, initializer: encodeSetupInitializer({ ...CONFIG, threshold: 3 }, contracts.fallbackHandler) })).not.toBe(base);
  });
});
