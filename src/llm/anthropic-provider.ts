import Anthropic from '@anthropic-ai/sdk';
import { LLM_DECISION_JSON_SCHEMA, parseDecision } from './decision-schema.ts';
import { costUsd } from './pricing.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from './ports.ts';

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface AnthropicProviderOptions {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly client?: Anthropic;
}

/**
 * Real provider.
 *
 * Three things matter here beyond "call the API".
 *
 * First, JSON is NOT requested in the prompt — it is enforced by the decoder.
 * `output_config.format` constrains generation to the schema, so the model cannot emit
 * prose, a markdown fence, or a fourth verdict value. Asking politely in a prompt and
 * then regex-ing a code fence out of the reply is the pattern this replaces.
 *
 * Second, the reply is still validated against the same schema on the way in. The
 * guarantee belongs to the API, not to this codebase, and a boundary with an external
 * system is the last place to trust a cast.
 *
 * Third, `effort: 'low'` — this is a bounded judgement over a handful of fields, not a
 * research task, and the cost line in the README is the point of the exercise.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly #client: Anthropic;
  readonly #timeoutMs: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#client = options.client ?? new Anthropic();
  }

  async decide(request: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.#call(request);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  async #call(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.#client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: LLM_DECISION_JSON_SCHEMA },
        },
        messages: [{ role: 'user', content: request.prompt }],
      },
      { timeout: this.#timeoutMs },
    );

    const raw = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const decision = parseDecision(raw);
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      decision,
      usage: { inputTokens, outputTokens, costUsd: costUsd(this.model, inputTokens, outputTokens) },
      model: response.model,
      raw,
    };
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) return error.status !== undefined && error.status >= 500;
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
