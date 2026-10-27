# Safe deployment mechanics

This document explains how Safe Migrator arrives at one Safe address, how it deploys the Safe, and
why it refuses to transfer anything until that deployment has been verified. The code lives in
`src/lib/services/safe-deployment.ts`, `signer-configuration.ts` and `onchain-verification.ts`.

References: [Multichain Safe deployment (Protocol Kit)](https://docs.safe.global/sdk/protocol-kit/guides/multichain-safe-deployment),
[Smart account multichain deployment](https://docs.safe.global/advanced/smart-account-multi-chain-deployment),
[Safe deployment guide](https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment),
[Supported networks](https://docs.safe.global/advanced/smart-account-supported-networks).

## 1. What determines a Safe address

A Safe is a proxy created by the Safe proxy factory with `CREATE2`:

```
address = keccak256(0xff ‖ factory ‖ salt ‖ keccak256(proxyCreationCode ‖ singleton))[12:]
salt    = keccak256(keccak256(initializer) ‖ saltNonce)
initializer = Safe.setup(owners, threshold, to=0, data=0x, fallbackHandler, paymentToken=0, payment=0, paymentReceiver=0)
```

The address is identical on two networks only if **every** one of these is identical:
the factory address, the proxy creation code, the singleton address, the owners and their order, the
threshold, the fallback handler and the salt nonce.

## 2. How Safe Migrator holds each input constant

| Input | How it is fixed |
| --- | --- |
| Owners | Checksummed, deduplicated and **sorted ascending** (`sortOwners`), so the order the user types them in never matters. |
| Threshold | 2 by default; validated against the number of owners. |
| Salt nonce | **Explicit** and derived from the source EOA: `keccak256("safe-migrator:v1:<source>:<variant>")`. Protocol Kit's default salt includes the chain ID, which would make the address differ per network. |
| Singleton | `isL1SafeSingleton: false` is always passed. Protocol Kit otherwise picks the L1 singleton on Ethereum mainnet and the L2 singleton elsewhere. |
| Factory, singleton, fallback handler | Chosen by **version negotiation** (below) and passed to Protocol Kit as `contractNetworks`, so the SDK cannot silently pick a different deployment type. |
| `to`, `data`, payment fields | Always zero or empty: no setup delegatecall, no modules, no payment. |

No module, guard or application-owned signer is ever added.

## 3. Version negotiation

`negotiateSafeVersion` tries v1.4.1, then v1.3.0. For each candidate and each network it:

1. Takes the **canonical** addresses from `@safe-global/safe-deployments` for the singleton (L2),
   proxy factory, fallback handler and helper contracts.
2. Reads `eth_getCode` at each address and compares `keccak256(code)` with the published `codeHash`.
3. Accepts the version on that network only if every required contract matches.

The newest version accepted on **all** selected networks wins. A network that cannot use it falls
back to its own best version and is shown with a *different* address and an explanation.

| Environment | Result | Why |
| --- | --- | --- |
| Sepolia + Gnosis Chiado + Base Sepolia (testnet) | **v1.3.0**, same address on all three | Chiado has no canonical v1.4.1 deployment. |
| Sepolia and/or Base Sepolia, without Chiado | v1.4.1, same address | Both carry canonical v1.4.1. |
| Ethereum, Base, Arbitrum, Optimism, Polygon | v1.4.1, same address | All carry the canonical v1.4.1 contracts. |

For v1.3.0 on Sepolia, `safe-deployments` lists both a `canonical` and an `eip155` set of addresses.
The pinned `contractNetworks` override forces the canonical set, which is the one Chiado and Base Sepolia also have.
Without it, the SDK's choice could produce a different address.

Both behaviours are checked against live RPCs by `npm run test:network`.

## 4. Prediction with an independent cross-check

`predictSafe` asks Protocol Kit for the address (`Safe.init({ predictedSafe }) → getAddress()`). It then
recomputes the address independently with viem, using the `proxyCreationCode()` read from the
factory. If the two differ, the network is marked `error` and execution is blocked.

## 5. What is already at the address?

`resolveChainTarget` inspects the predicted address:

| Code at address | Status | Behaviour |
| --- | --- | --- |
| None | `not_deployed` | A deployment action is planned. |
| A Safe with the expected owners, threshold, singleton, fallback handler, no modules and no guard | `deployed_matching` | Deployment is **skipped**; transfers go to the existing Safe. |
| Anything else | `deployed_mismatch` | **Blocked**. The app never assumes an unrelated contract is compatible. |

`inspectSafe` reads the singleton from storage slot 0. It reads `getOwners`, `getThreshold`,
`VERSION`, `nonce`, the fallback handler (from its storage slot), the guard (from its storage slot)
and `getModulesPaginated`, all at one block number.

## 6. Building the deployment transaction

`buildDeploymentTransaction` calls Protocol Kit's `createSafeDeploymentTransaction()` and then
**decodes the result** before it is ever shown to the wallet. `inspectDeploymentTransaction`
rejects the transaction unless all of the following hold:

* `to` is the negotiated proxy factory and `value` is 0.
* The calldata is exactly `createProxyWithNonce(singleton, initializer, saltNonce)` with no trailing bytes.
* The singleton and salt nonce are the expected ones.
* The initializer is byte-identical to a locally encoded owners/threshold-only `setup` call.

Unit tests cover the ways this could be tampered with: a wrong factory, attached value, a modules
delegatecall, a payment, a different salt and trailing bytes.

## 7. Two-stage execution: deploy, verify, then transfer

For each network, the executor:

1. Validates the wallet's chain ID and account.
2. Re-inspects the address. If a matching Safe has appeared meanwhile, it skips deployment.
3. Simulates and estimates the deployment, checks the gas balance, then asks the wallet to send it.
4. Persists the transaction hash, then waits for the receipt and the network's confirmation depth.
5. Re-reads the Safe and runs `compareSafeToConfig`. Only if there are **zero** issues does the
   network move on to transfers.

In sequential mode, assets are never sent to a merely predicted address.

With EIP-5792 atomic batching, steps 3–5 collapse into one transaction: the deployment is the
first call of the batch and the token transfers follow. This is only done when the CREATE2 address
recomputed from the deployment calldata equals the transfers' target. Atomicity guarantees the
transfers revert unless that exact deployment succeeds. Step 5 runs right after the batch, and the
native remainder is only sent once it passes. See [BATCHING.md](BATCHING.md#strategy-1-eip-5792).

## 8. Opening the Safe

After verification, the completion screen links to
`https://app.safe.global/home?safe=<prefix>:<address>` using each network's Safe{Wallet} short name
(`sep`, `chi`, `eth`, `base`, `arb1`, `oeth`, `matic`). Safe{Wallet} indexes new Safes automatically;
indexing on Chiado can lag by a few minutes.

## Pinned recipes (v1.5)

Once a Safe is saved (frozen for owner verification or used by a run), its **deployment recipe** is
pinned in the profile: derivation `safe-proxy-factory-create2-v1`, Safe version, L2 singleton,
factory, fallback handler, the exact `setup` initializer, the salt nonce and the factory's
`proxyCreationCode` (and its hash). Its commitment is

```
keccak256(abi.encode("safe-migrator/deployment-recipe/v1", derivation, version, "l2", factory,
                     singleton, fallbackHandler, keccak256(initializer), saltNonce,
                     keccak256(proxyCreationCode)))
```

and the address is recomputed offline from the recipe. On any network, `resolvePinnedTarget`
verifies the canonical code hashes for the pinned version, that the factory's creation code has the
pinned hash, that the recipe still yields the recorded address and that Protocol Kit agrees. It never
picks another version. A network without the pinned version is `incompatible`; an unreadable network
is reported as unknown. Code found at the address is classified as the original configuration,
changed governance (a Safe from this recipe whose owners or settings were changed later) or a
conflicting contract.

Note that the original recipe recreates the same address on a new network with the **original**
owners, even if owners were changed on other networks. That is why adding a network is blocked
while any known deployment's governance diverged or cannot be read.
