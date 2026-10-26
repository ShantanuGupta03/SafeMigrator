import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Safe Migrator — Secure your onchain portfolio",
  description: "Move assets from a single-key wallet into a multi-signature Safe across EVM networks.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f5f5" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
