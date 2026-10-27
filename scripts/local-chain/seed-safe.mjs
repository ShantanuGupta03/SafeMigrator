// Installs the canonical Safe v1.3.0 runtime code at its canonical addresses on a local Hardhat node
// (hardhat_setCode), after checking each code hash against @safe-global/safe-deployments.
// Usage: node scripts/local-chain/seed-safe.mjs http://127.0.0.1:8545 [...more]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { keccak256 } from "viem";

// viem ships Multicall3's creation bytecode but does not export it.
const viemDir = dirname(createRequire(import.meta.url).resolve("viem/package.json"));
const multicall3Bytecode = /multicall3Bytecode = '(0x[0-9a-f]+)'/.exec(readFileSync(join(viemDir, "_esm/constants/contracts.js"), "utf8"))?.[1];
if (!multicall3Bytecode) throw new Error("Multicall3 bytecode not found in viem");
import * as sd from "@safe-global/safe-deployments";

const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/safe-v1.3.0-runtime.json", import.meta.url), "utf8"));
const getters = {
  singleton: sd.getSafeL2SingletonDeployment,
  proxyFactory: sd.getProxyFactoryDeployment,
  fallbackHandler: sd.getCompatibilityFallbackHandlerDeployment,
  multiSend: sd.getMultiSendDeployment,
  multiSendCallOnly: sd.getMultiSendCallOnlyDeployment,
  createCall: sd.getCreateCallDeployment,
  simulateTxAccessor: sd.getSimulateTxAccessorDeployment,
};

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

for (const url of process.argv.slice(2)) {
  for (const [key, getter] of Object.entries(getters)) {
    const c = fixture.contracts[key];
    const canonical = getter({ version: "1.3.0", released: true }).deployments.canonical;
    if (!c || c.address.toLowerCase() !== canonical.address.toLowerCase() || keccak256(c.runtimeCode) !== canonical.codeHash.toLowerCase()) {
      throw new Error(`Fixture for ${key} does not match the canonical v1.3.0 deployment`);
    }
    await rpc(url, "hardhat_setCode", [c.address, c.runtimeCode]);
    const onchain = await rpc(url, "eth_getCode", [c.address, "latest"]);
    if (keccak256(onchain) !== canonical.codeHash.toLowerCase()) throw new Error(`setCode failed for ${key} on ${url}`);
  }
  // Multicall3 exists on every public testnet; discovery batches its balance reads through it.
  const multicallRuntime = await rpc(url, "eth_call", [{ data: multicall3Bytecode }, "latest"]);
  await rpc(url, "hardhat_setCode", ["0xcA11bde05977b3631167028862bE2a173976CA11", multicallRuntime]);
  console.log(`Seeded canonical Safe v1.3.0 contracts and Multicall3 on ${url}`);
}
