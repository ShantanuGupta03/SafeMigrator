// Local fork node used by `npm run test:fork`. Keeps the real chain ID so registry lookups and
// chain-ID validation behave exactly as on the live testnet.
module.exports = {
  networks: {
    hardhat: {
      chainId: Number(process.env.FORK_CHAIN_ID),
      forking: { url: process.env.FORK_URL },
      chains: {
        10200: { hardforkHistory: { cancun: 0, prague: 0 } },
        84532: { hardforkHistory: { cancun: 0, prague: 0 } },
        11155111: { hardforkHistory: { cancun: 0, prague: 0 } },
      },
    },
  },
};
