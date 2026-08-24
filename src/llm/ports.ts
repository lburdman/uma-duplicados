/**
 * LLM port.
 *
 * The pipeline never talks to a vendor SDK. It asks this interface a question and gets
 * back a verdict plus the accounting needed to answer "what did this cost". Swapping
 * the mock for a real model is a one-line change in the composition root, and every
 * finding's trace already records which one answered.
 */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** What this call actually cost. Zero for a mock, and the report says so. */
  readonly costUsd: number;
  /**
   * What it would have cost against a real model at list price.
   *
   * Carried alongside the real figure rather than derived later, because only the
   * provider knows which model it is standing in for and whether it was billed at the
   * batch discount. "USD 0,00 per document" is a true number and a useless one.
   */
  readonly projectedCostUsd?: number;
}

export interface LlmDecision {
  readonly verdict: 'DUPLICATE' | 'NOT_DUPLICATE' | 'UNCERTAIN';
  readonly confidence: number;
  readonly reason: string;
}

export interface LlmRequest {
  readonly promptId: string;
  readonly promptVersion: string;
  readonly prompt: string;
}

export interface LlmResponse {
  readonly decision: LlmDecision;
  readonly usage: LlmUsage;
  readonly model: string;
  /** Raw text the model returned, stored verbatim in the trace for impugnación. */
  readonly raw: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  decide(request: LlmRequest): Promise<LlmResponse>;
}
