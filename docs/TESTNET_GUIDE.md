# Testnet demonstration guide

This guide walks through a real migration on **Sepolia** and **Gnosis Chiado**. You need a browser
wallet (MetaMask, Rabby, …) with a throwaway test account, plus two other addresses you control to
act as Safe owners. They can be other accounts in the same wallet, or a hardware wallet.

## 1. Run the app

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables are needed for testnets: public RPCs and the Blockscout indexer are used
by default.

## 2. Get testnet gas

Open **`/testnet`** (the "Test assets" link in the header). It lists the faucets and lets you
switch networks.

| Network | Faucet | Suggested amount |
| --- | --- | --- |
| Sepolia | [Google Cloud](https://cloud.google.com/application/web3/faucet/ethereum/sepolia), [Alchemy](https://www.alchemy.com/faucets/ethereum-sepolia) | 0.05 ETH |
| Sepolia | [Circle USDC faucet](https://faucet.circle.com) (optional, real test USDC) | 10 USDC |
| Chiado | [Gnosis Chiado faucet](https://faucet.chiadochain.net) | 0.05 xDAI |
| Base Sepolia | [Coinbase Developer Platform](https://portal.cdp.coinbase.com/products/faucet), [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Superchain](https://console.optimism.io/faucet) | 0.01 ETH |
| Base Sepolia | [Circle USDC faucet](https://faucet.circle.com) (optional) | 10 USDC |

Gas on all three networks is cheap: deploying a 3-owner Safe costs roughly 250–300k gas and a token
transfer about 35–60k gas. The preview shows the exact estimate.

## 3. Create sample assets

On `/testnet`, with the wallet on the target network, click **Deploy** for the presets you want.
Each preset is one transaction that deploys a testnet-only contract (`contracts/TestAssets.sol`)
and mints to you. The new contracts are added automatically as manual imports, so discovery
re-reads them onchain.

| Preset | Exercises |
| --- | --- |
| Demo USD (mUSD, 6 decimals) | Decimal handling; a standard ERC-20 transfer |
| Demo Token (MDT, 18 decimals) | A second ERC-20 on the same chain |
| Fee token (FEED, 1% fee) | The Safe receives less than was sent, so the action shows **"verified, amount differs"** |
| Restricted token (RSTD) | `transfer` always reverts, so the preflight simulation fails and the asset is **excluded** and left behind |
| Demo NFT (ERC-721, IDs 1–3) | `safeTransferFrom` into the Safe |
| Soulbound badge (ERC-721) | Transfers revert, so it is an account-bound asset that stays behind |
| Multi-token (ERC-1155, IDs 1–3) | `safeBatchTransferFrom` of several IDs in one transaction |

For the definition-of-done scenario, deploy **mUSD + the fee token + the restricted token on both
networks**.

## 4. Migrate

1. **Connect** on `/`. The detected wallet type is shown (EOA, EIP-7702-delegated EOA or contract).
2. **Discover.** Every selected testnet is scanned (toggle Base Sepolia on with its chip if an older session saved only Sepolia + Chiado). Check the coverage line on each network card. Select
   the assets to move; *Select all transferable* skips suspicious and unsupported items.
3. **Signers.** Enter three owners. Use *Use connected wallet* for one, and paste or ENS-resolve the
   other two. The predicted Safe address appears per network. On Sepolia, Chiado and Base Sepolia it is the
   **same address**, because all three use canonical Safe v1.3.0.
   * Optional: switch your wallet to another owner account and click **Verify control** on that
     owner's card. Owner verification is required only on production networks.
4. **Preview.** Review each network's plan:
   * whether the Safe will be deployed or is already deployed;
   * the actions, the estimated fees and the native reserve;
   * excluded assets, with the simulation's reason;
   * the strategy and the expected wallet confirmations.

   A conventional wallet needs 1 deployment, plus 1 transaction per asset, on each network, plus one
   network switch. Tick the review box and click **Migrate to Safe**.
5. **Progress.** Approve each prompt. Each network moves through: deploying, verifying the Safe,
   transferring, confirming and verifying balances.
6. **Complete.** The app re-reads each Safe (owners, threshold, version) and both balances onchain.
   It lists what moved and what remains, with explorer links, the JSON receipt and **Open in
   Safe{Wallet}**.

## 5. Scenarios to try

| Scenario | How to trigger it | Expected result |
| --- | --- | --- |
| Safe already deployed | Finish a migration, deploy another sample token, then start again with the same owners | The network shows "Safe already deployed with the expected configuration". There is no deployment action, only transfers. |
| Wallet without batching | Any standard EOA wallet | The strategy is one-by-one, and the preview counts one confirmation per transaction |
| Rejected signature or transaction | Reject a prompt during progress | The run stops with *A wallet request was rejected*. Other networks are untouched. **Retry failed actions** continues without redeploying. |
| Insufficient gas | Use an account with nearly no ETH/xDAI | The preview blocks the network and shows the deficit. Top up, then refresh or Retry. |
| Non-transferable asset | The restricted token or soulbound badge | Excluded by simulation, with a reason, and listed as remaining |
| Token transfer reverts | A token that starts reverting after the preview | The action is marked *Failed (reverted)*. The rest of the chain continues, and Retry is available. |
| Session interrupted | Close the tab after approving a transfer, then reopen | The progress screen offers **Resume**. It reconciles the saved hash from the receipt and does not resend. |
| Partial migration resumed | Pause mid-run, or stop after one network | Completed networks stay completed. Resume continues the rest. |
| Unsupported chain | Leave the wallet on a network outside the registry | Discovery does not depend on the wallet's network, and its coverage line states exactly which networks were scanned. Before each transaction the executor asks the wallet to switch to the target network and re-checks the chain ID. |

## 6. Automated fork run (no faucets needed)

`npm run test:fork` runs the same planning and execution code against local forks of Sepolia and
Chiado. Those forks contain the real Safe contracts, use a throwaway key and run on the real EVM.

The script does the following:
* installs Hardhat 2 into `.fork/`, which is gitignored and never an app dependency;
* starts two fork nodes on ports 8545 and 8546, keeping the real chain IDs;
* runs `tests/integration/fork-migration.test.ts`.

The run covers the deployment and same-address check, transfers and verification, an existing
Safe, rejection then retry, and a crash then resume. Public RPCs prune historical state quickly,
so the script starts the forks immediately before the tests. Set `FORK_SEPOLIA_RPC` /
`FORK_CHIADO_RPC` to archive endpoints if a run fails with "historical state is not available".
