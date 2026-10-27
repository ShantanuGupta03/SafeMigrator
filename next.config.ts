import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import pkg from "./package.json";

/** Build provenance shown in receipts. Never fails the build: unknown stays unknown. */
function buildCommit(): string {
  if (process.env.NEXT_PUBLIC_BUILD_COMMIT) return process.env.NEXT_PUBLIC_BUILD_COMMIT;
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BUILD_COMMIT: buildCommit(), NEXT_PUBLIC_APP_VERSION: pkg.version },
  turbopack: { root: __dirname },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Invitation links carry their payload in the fragment; never leak even the path to third parties.
      { source: "/invite", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
