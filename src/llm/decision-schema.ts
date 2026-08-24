import { z } from 'zod/v4';

/**
 * One schema, two jobs.
 *
 * The JSON Schema handed to the API and the validator applied to the reply are derived
 * from the same declaration. Writing them separately is how they drift: the API starts
 * allowing a field the parser silently drops, or the parser starts demanding one the API
 * never promised, and nobody notices until a verdict comes back malformed in production.
 */
export const LlmDecisionSchema = z.object({
  verdict: z.enum(['DUPLICATE', 'NOT_DUPLICATE', 'UNCERTAIN']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type ValidatedDecision = z.infer<typeof LlmDecisionSchema>;

/** Fed to `output_config.format` so the decoder cannot emit anything else. */
export const LLM_DECISION_JSON_SCHEMA = z.toJSONSchema(LlmDecisionSchema);

/**
 * Validate a reply.
 *
 * With structured outputs on, this should never fail — which is exactly why it is here.
 * The guarantee belongs to the API, not to this codebase, and the day the pipeline runs
 * behind a provider that does not enforce it, or the schema is edited on one side only,
 * this is the difference between a clear error and a finding built on garbage.
 */
export function parseDecision(raw: string): ValidatedDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`LLM reply was not JSON: ${raw.slice(0, 200)}`);
  }
  const result = LlmDecisionSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`LLM reply did not match the decision schema: ${result.error.message}`);
  }
  return result.data;
}
