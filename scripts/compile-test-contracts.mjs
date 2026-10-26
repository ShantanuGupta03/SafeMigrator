// Compiles contracts/TestAssets.sol with solc-js and writes ABI + bytecode for the testnet tools page.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const source = readFileSync(new URL("../contracts/TestAssets.sol", import.meta.url), "utf8");
const input = {
  language: "Solidity",
  sources: { "TestAssets.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

const wanted = ["SampleToken", "FeeOnTransferToken", "RestrictedToken", "SampleNFT", "SampleMultiToken"];
const artifacts = {};
for (const name of wanted) {
  const c = output.contracts["TestAssets.sol"][name];
  artifacts[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

mkdirSync(new URL("../src/lib/testnet/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../src/lib/testnet/artifacts.json", import.meta.url),
  JSON.stringify({ compiler: solc.version(), artifacts }, null, 2),
);
console.log(`Compiled ${wanted.length} contracts with solc ${solc.version()}`);
