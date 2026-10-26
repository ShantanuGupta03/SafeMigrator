# Implementation milestones

Status legend: ✅ implemented · 🧪 experimental (implemented, needs real-world validation) · ⏳ future

## Milestone A — Working deployment PoC (Sepolia + Gnosis Chiado)
| Item | Status |
| --- | --- |
| EOA connection via EIP-1193 / EIP-6963 injected wallets (wagmi) | ✅ |
| Native + ERC-20 discovery (indexer + RPC verification + known-token list) | ✅ |
| 2-of-3 signer setup with validation, ENS, sorting | ✅ |
| Deterministic address prediction (Protocol Kit) + independent CREATE2 cross-check | ✅ |
| Version negotiation (v1.3.0 canonical on Sepolia + Chiado ⇒ same address) | ✅ |
| Deployment on both networks via user's wallet | ✅ (fork-verified, `npm run test:fork`) |
| Onchain verification of owners, threshold, singleton, modules, guard, fallback handler | ✅ (fork-verified) |
| Native + ERC-20 transfers, post-transfer balance verification | ✅ (fork-verified, incl. fee-on-transfer discrepancy and restricted-token exclusion) |
| Testnet sample tokens (deployable from the app) + faucet docs | ✅ |
| Manual signed run on public Sepolia + Chiado with a browser wallet | ⏳ needs a funded user wallet — see `TESTNET_GUIDE.md` |

## Milestone B — Comprehensive transferable assets
| Item | Status |
| --- | --- |
| ERC-721 `safeTransferFrom` with receivability simulation | ✅ |
| ERC-1155 single + batch transfers | ✅ |
| Configurable indexer (`blockscout` default, `alchemy` optional) | ✅ |
| Manual token / NFT import (verified onchain) | ✅ |
| Gas reserve, native-last, dust policy, deficit blocking | ✅ |
| EIP-5792 capability detection | ✅ |
| Atomic batching (`wallet_sendCalls`, `atomicRequired: true`) with sequential fallback | 🧪 (depends on wallet) |
| Partial failure recovery, retry without duplicates | ✅ (unit + fork: rejection→retry, crash→resume) |

## Milestone C — Mainnet-ready architecture
| Item | Status |
| --- | --- |
| Ethereum, Base, Arbitrum, Optimism, Polygon in registry (discovery) | ✅ |
| v1.4.1 canonical contract verification on production networks | ✅ (automatic, onchain) |
| OP-stack L1 data fee estimation | ✅ |
| Execution gated by env + per-chain allowlist + verified owners | ✅ |
| Independent production validation run | ⏳ (see `docs/SECURITY.md` checklist) |

## Milestone D — Hardening and UX
| Item | Status |
| --- | --- |
| Unit tests (Vitest) for math, validation, capabilities, state machine, planning, decoding | ✅ |
| Playwright smoke tests for critical screens | ✅ |
| Fork end-to-end tests (real Safe contracts, real EVM) | ✅ |
| Wallet rejection handling (4001, 5750) | ✅ |
| Transaction simulation (`eth_call` / `estimateGas`) before every write | ✅ |
| Duplicate execution prevention (intent IDs, pending-nonce check, reconciliation) | ✅ |
| Deployment compatibility errors | ✅ |
| Receipt export (JSON) | ✅ |
| Owner control verification (EIP-712) | ✅ |
| Security warnings, responsive UI | ✅ |
