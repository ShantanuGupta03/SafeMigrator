import type { Config } from "wagmi";
import { getConnection, sendTransaction, switchChain } from "wagmi/actions";
import type { Hex } from "viem";
import type { SendTxRequest, WalletPort } from "@/lib/services/migration-execution";
import type { Eip1193Requester } from "@/lib/services/transaction-capability";

async function connectedProvider(config: Config): Promise<Eip1193Requester> {
  const { connector } = getConnection(config);
  if (!connector) throw new Error("No wallet connected");
  return (await connector.getProvider()) as Eip1193Requester;
}

/** Production WalletPort: every write goes through the user's connected wallet via wagmi. */
export function createWagmiWalletPort(config: Config): WalletPort {
  return {
    getAccount: () => getConnection(config).address,
    async getChainId() {
      // Ask the wallet directly rather than trusting cached UI state.
      const provider = await connectedProvider(config);
      return Number(await provider.request({ method: "eth_chainId" }));
    },
    async switchChain(chainId) {
      await switchChain(config, { chainId });
    },
    async sendTransaction(req: SendTxRequest): Promise<Hex> {
      const account = getConnection(config).address;
      if (!account) throw new Error("No wallet connected");
      const fees =
        req.maxFeePerGas !== undefined
          ? { maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas }
          : { gasPrice: req.gasPrice };
      // wagmi asserts the connector is on `chainId` before sending (wrong-network protection).
      return sendTransaction(config, {
        chainId: req.chainId,
        account,
        to: req.to,
        data: req.data,
        value: req.value,
        gas: req.gas,
        ...fees,
      } as never);
    },
    provider: () => connectedProvider(config),
  };
}
