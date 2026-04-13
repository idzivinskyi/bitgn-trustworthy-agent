// ── Cost calculation ─────────────────────────────────────────────────────
// Prices per million tokens (USD). Cache read = 10% of input, cache write = 125% of input (5min TTL).
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":        { input: 5,    output: 25 },
  "claude-opus-4-5":        { input: 5,    output: 25 },
  "claude-opus-4-1":        { input: 15,   output: 75 },
  "claude-opus-4":          { input: 15,   output: 75 },
  "claude-sonnet-4-6":      { input: 3,    output: 15 },
  "claude-sonnet-4-5":      { input: 3,    output: 15 },
  "claude-sonnet-4":        { input: 3,    output: 15 },
  "claude-haiku-4-5":       { input: 1,    output: 5 },
  "claude-haiku-3-5":       { input: 0.80, output: 4 },
};

export function getModelPricing(model: string): { input: number; output: number } {
  // Try exact match first, then prefix match for dated model IDs
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Default to sonnet pricing as fallback
  return { input: 3, output: 15 };
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = getModelPricing(model);
  const M = 1_000_000;
  // API returns input_tokens as non-cached tokens only; cache fields are additive.
  const cost =
    (inputTokens / M) * pricing.input +
    (cacheReadTokens / M) * pricing.input * 0.1 +
    (cacheCreateTokens / M) * pricing.input * 1.25 +
    (outputTokens / M) * pricing.output;
  return cost;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
