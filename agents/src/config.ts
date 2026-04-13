import { z } from "zod";

const ConfigSchema = z.object({
  // Anthropic credentials
  apiKey: z.string().optional(), // ANTHROPIC_API_KEY

  // BitGN platform credentials
  bitgnApiKey: z.string().optional(), // BITGN_API_KEY

  // Model + limits
  modelId: z.string().default("claude-sonnet-4-6"), // MODEL_ID
  maxIterations: z.coerce.number().int().positive().default(20), // MAX_ITERATIONS
  maxTokens: z.coerce.number().int().positive().default(16384), // MAX_TOKENS

  // Benchmark — benchmarkHost intentionally not validated as URL (localhost:8080 is valid)
  benchmarkHost: z.string().min(1).default("https://api.bitgn.com"), // BENCHMARK_HOST
  benchmarkId: z.string().default("bitgn/pac1-dev"), // BENCHMARK_ID bitgn/pac1-prod

  // Runtime
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "silent"])
    .default("info"), // LOG_LEVEL
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate config from environment variables.
 * Throws ZodError on invalid values — call once at startup.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return ConfigSchema.parse({
    apiKey: env.ANTHROPIC_API_KEY,
    bitgnApiKey: env.BITGN_API_KEY,
    modelId: env.MODEL_ID,
    maxIterations: env.MAX_ITERATIONS,
    maxTokens: env.MAX_TOKENS,
    benchmarkHost: env.BENCHMARK_HOST,
    benchmarkId: env.BITGN_BENCH ?? env.BENCHMARK_ID,
    logLevel: env.LOG_LEVEL,
  });
}
