/**
 * Published Anthropic list prices, USD per 1M tokens (checked 2026-08-24).
 *
 * Hardcoded on purpose: a cost figure in a report must be reproducible, and a number
 * fetched at runtime is not. When prices move, this table moves with a commit.
 */
export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export const PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'claude-sonnet-5': { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}
