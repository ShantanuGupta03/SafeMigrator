"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { AppStateProvider } from "@/components/app-state";
import { createWagmiConfig } from "@/lib/wallet/wagmi-config";

export function Providers({ children }: { children: React.ReactNode }) {
  const [config] = useState(() => createWagmiConfig());
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <AppStateProvider>{children}</AppStateProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
