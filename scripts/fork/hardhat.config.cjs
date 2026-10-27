// Local node used by `npm run test:fork` (FORK_URL set: fork of a live testnet) and
// `npm run test:local` (no FORK_URL: empty chain seeded with the canonical Safe v1.3.0 runtime code).
// Keeps the real chain ID so registry lookups and chain-ID validation behave as on the live testnet.
module.exports = {
  networks: {
    hardhat: {
      chainId: Number(process.env.FORK_CHAIN_ID),
      ...(process.env.FORK_URL ? { forking: { url: process.env.FORK_URL } } : {}),
      accounts: { count: 10, accountsBalance: "1000000000000000000000000" },
      chains: {
        10200: { hardforkHistory: { cancun: 0, prague: 0 } },
        84532: { hardforkHistory: { cancun: 0, prague: 0 } },
        11155111: { hardforkHistory: { cancun: 0, prague: 0 } },
      },
    },
  },
};
