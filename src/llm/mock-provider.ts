import { parseDecision } from './decision-schema.ts';
import { costUsd } from './pricing.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from './ports.ts';

/**
 * Deterministic stand-in for a real model.
 *
 * It exists so `pnpm start` works with no API key, and so the idempotency test has a
 * stable layer 2 — a real model is not bit-reproducible, and a pipeline whose output
 * changes between runs cannot claim idempotency.
 *
 * Its rule is stated openly rather than hidden behind the word "mock", and it is the
 * conservative one this project committed to: a mock has no clinical knowledge, so it
 * cannot overturn the reading that a multi-region code covers several regions, and it
 * never manufactures a debit. NOT_DUPLICATE where the policy already offers a benign
 * explanation, UNCERTAIN where it does not. Both produce no finding.
 *
 * The consequence is worth being clear about: on this lot layer 2 emits nothing. That
 * is not layer 2 being useless — it is layer 2 doing its job, which is to stop 22
 * plausible-looking groups from becoming false debits. A real model behind the same
 * prompt may decide otherwise; the trace records which one answered.
 *
 * Token counts are estimated from text length so the cost report has real arithmetic
 * in it, and the README says the figure is a projection.
 */
export class MockLlmProvider implements LlmProvider {
  readonly id = 'mock';
  readonly model = 'mock-deterministic-v1';

  async decide(request: LlmRequest): Promise<LlmResponse> {
    const count = countItems(request.prompt);
    const multiRegion = request.prompt.includes('"repeatability": "MULTI_REGION"');

    const decision = multiRegion
      ? {
          verdict: 'NOT_DUPLICATE' as const,
          confidence: 0.7,
          reason: `${count} charges are consistent with distinct regions covered by this single code, and nothing in the row distinguishes that from a re-bill`,
        }
      : {
          verdict: 'UNCERTAIN' as const,
          confidence: 0.4,
          reason: 'practice is unclassified and the evidence does not settle it either way',
        };

    // Round-tripped through the same validator the real provider uses, so a change to
    // the decision shape breaks here too instead of only in production.
    const raw = JSON.stringify(decision);
    parseDecision(raw);

    // ~4 characters per token is close enough for a cost estimate and needs no tokenizer.
    const inputTokens = Math.ceil(request.prompt.length / 4);
    const outputTokens = 40;
    return {
      decision,
      usage: { inputTokens, outputTokens, costUsd: costUsd(this.model, inputTokens, outputTokens) },
      model: this.model,
      raw,
    };
  }
}

function countItems(prompt: string): number {
  const match = /"itemCount":\s*(\d+)/.exec(prompt);
  return match ? Number(match[1]) : 0;
}
