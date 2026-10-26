import { createConfig, http, type Config, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { arbitrum, base, baseSepolia, gnosisChiado, mainnet, optimism, polygon, sepolia } from "viem/chains";
import { rpcUrlFor } from "@/lib/chains/clients";
import { appConfig } from "@/lib/config";

export const WAGMI_CHAINS = [sepolia, gnosisChiado, baseSepolia, mainnet, base, arbitrum, optimism, polygon] as const;

export function createWagmiConfig(): Config {
  const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  if (appConfig.walletConnectProjectId) {
    connectors.push(
      walletConnect({
        projectId: appConfig.walletConnectProjectId,
        showQrModal: true,
        metadata: {
          name: "Safe Migrator",
          description: "Move assets from an EOA into a multi-signature Safe",
          url: typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
          icons: [],
        },
      }),
    );
  }
  return createConfig({
    // Defer restoring the stored connection until after hydration so server and client HTML match.
    ssr: true,
    chains: WAGMI_CHAINS,
    connectors,
    // EIP-6963: lists every injected wallet (MetaMask, Rabby, Coinbase, Frame/hardware bridges…).
    multiInjectedProviderDiscovery: true,
    transports: Object.fromEntries(WAGMI_CHAINS.map((c) => [c.id, http(rpcUrlFor(c.id))])) as Record<
      (typeof WAGMI_CHAINS)[number]["id"],
      ReturnType<typeof http>
    >,
  });
}
