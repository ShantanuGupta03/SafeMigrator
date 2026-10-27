import { z } from "zod";

/**
 * Public (client-visible) configuration. Next.js inlines NEXT_PUBLIC_* at build time, so each
 * variable must be referenced literally. Never put credentials here.
 */
const raw = {
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  enableMainnetExecution: process.env.NEXT_PUBLIC_ENABLE_MAINNET_EXECUTION,
  mainnetExecutionChains: process.env.NEXT_PUBLIC_MAINNET_EXECUTION_CHAINS,
  gasLimitMarginBps: process.env.NEXT_PUBLIC_GAS_LIMIT_MARGIN_BPS,
  feeMarginBps: process.env.NEXT_PUBLIC_FEE_MARGIN_BPS,
  dustFeeMultiple: process.env.NEXT_PUBLIC_DUST_FEE_MULTIPLE,
  enableAaveV3Beta: process.env.NEXT_PUBLIC_ENABLE_AAVE_V3_BETA,
};

const bps = (fallback: number, min: number) =>
  z.coerce.number().int().min(min).max(50_000).catch(fallback);

const schema = z.object({
  walletConnectProjectId: z.string().trim().min(1).optional().catch(undefined),
  enableMainnetExecution: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .catch(false),
  mainnetExecutionChains: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    )
    .catch([]),
  gasLimitMarginBps: bps(13_000, 10_000),
  feeMarginBps: bps(12_500, 10_000),
  dustFeeMultiple: z.coerce.number().int().min(1).max(1000).catch(3),
  /** Aave v3 supply-position adapter (beta). Off unless explicitly "true"; see docs/V1_5_IMPLEMENTATION.md. */
  enableAaveV3Beta: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .catch(false),
});

export type AppConfig = z.infer<typeof schema>;

export const appConfig: AppConfig = schema.parse(raw);
