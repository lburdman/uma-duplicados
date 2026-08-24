import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  PAGE_EXTRACTION_JSON_SCHEMA,
  parsePageExtraction,
} from './page-extraction.ts';
import type {
  PageExtractionProvider,
  PageExtractionResult,
  PageImage,
} from './page-extraction.ts';
import { costUsd } from './pricing.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, '../../prompts/extract-page.v1.md');

/** Sonnet, not Opus. See ADR 0007: transcription is not the task Opus is worth paying for. */
const DEFAULT_MODEL = 'claude-sonnet-5';

export interface AnthropicPageExtractionOptions {
  readonly model?: string;
  readonly mode?: 'sync' | 'batch';
  readonly client?: Anthropic;
  readonly timeoutMs?: number;
  /** How often to ask whether the batch has finished. 30 s in production. */
  readonly batchPollMs?: number;
  /** Give up after this long. Six hours: past that, something is wrong, not slow. */
  readonly batchTimeoutMs?: number;
}

/**
 * Third extraction tier: read the page image with a multimodal model.
 *
 * Reached only when there is no text layer AND no local OCR. That ordering is the cost
 * argument in one line — this is the only tier that bills per page, so it is the last
 * one asked.
 *
 * Two things carry over from the detection provider and matter just as much here. The
 * reply shape is constrained by `output_config.format`, so the model cannot answer with
 * prose about what it sees. And the reply is validated against the same schema on the
 * way in, because a boundary with an external system is the last place to trust a cast.
 */
export class AnthropicPageExtractionProvider implements PageExtractionProvider {
  readonly id = 'anthropic-multimodal';
  readonly model: string;
  readonly mode: 'sync' | 'batch';
  readonly #client: Anthropic;
  readonly #timeoutMs: number;
  readonly #batchPollMs: number;
  readonly #batchTimeoutMs: number;

  constructor(options: AnthropicPageExtractionOptions = {}) {
    this.model = options.model ?? process.env.OCR_LLM_MODEL ?? DEFAULT_MODEL;
    this.mode = options.mode ?? (process.env.OCR_LLM_MODE === 'batch' ? 'batch' : 'sync');
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#batchPollMs = options.batchPollMs ?? 30_000;
    this.#batchTimeoutMs = options.batchTimeoutMs ?? 6 * 60 * 60 * 1000;
    this.#client = options.client ?? new Anthropic();
  }

  async extractPages(pages: readonly PageImage[]): Promise<PageExtractionResult[]> {
    if (this.mode === 'batch') return this.#extractViaBatch(pages);
    const results: PageExtractionResult[] = [];
    for (const page of pages) results.push(await this.#extractOne(page));
    return results;
  }

  async #extractOne(page: PageImage): Promise<PageExtractionResult> {
    const prompt = await readFile(PROMPT_PATH, 'utf8');
    const response = await this.#client.messages.create(this.#requestFor(page, prompt), {
      timeout: this.#timeoutMs,
    });

    const raw = textOf(response.content);
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      page: page.page,
      extraction: parsePageExtraction(raw),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: costUsd(this.model, inputTokens, outputTokens),
        projectedCostUsd: costUsd(this.model, inputTokens, outputTokens),
      },
      model: response.model,
    };
  }

  #requestFor(page: PageImage, prompt: string): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: 8_000,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: PAGE_EXTRACTION_JSON_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  /**
   * Batch path — half price, answers within the hour instead of within seconds.
   *
   * Extraction is the one stage in this pipeline where that trade is obviously right:
   * a rendición batch is processed on a daily cycle, so nothing downstream is waiting on
   * a page, and the volume is exactly where a 50 % discount stops being a rounding error.
   * Detection is the opposite — 22 calls, cents, and a human waiting on the result.
   *
   * The plural `extractPages` signature exists for this. Batches need every request up
   * front; a per-page interface would have had to be rewritten to adopt it.
   */
  async #extractViaBatch(pages: readonly PageImage[]): Promise<PageExtractionResult[]> {
    const prompt = await readFile(PROMPT_PATH, 'utf8');
    const requests = pages.map((page) => ({
      custom_id: `page-${page.page}`,
      params: this.#requestFor(page, prompt),
    }));

    const created = await this.#client.messages.batches.create({ requests });

    // A batch is not ready when it is created. It is ready when the API says so, which
    // for a real submission is minutes to hours away — that latency IS the discount.
    // Asking for results before then does not block, it fails, and the whole document
    // would come back empty. This is exactly the kind of defect that only shows up the
    // first time the code actually runs, which is why it runs against a wire test.
    const batch = await this.#awaitCompletion(created.id);

    // Results come back in ANY order, so they are keyed by custom_id, never by position.
    const byPage = new Map<number, PageExtractionResult>();
    for await (const entry of await this.#client.messages.batches.results(batch)) {
      const page = Number(entry.custom_id.replace('page-', ''));
      if (entry.result.type !== 'succeeded') continue;
      const message = entry.result.message;
      const raw = textOf(message.content);
      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      const listed = costUsd(this.model, inputTokens, outputTokens);
      byPage.set(page, {
        page,
        extraction: parsePageExtraction(raw),
        usage: { inputTokens, outputTokens, costUsd: listed / 2, projectedCostUsd: listed / 2 },
        model: message.model,
      });
    }

    // A page whose request failed simply produced nothing; the chain sees an empty page
    // and the reconciliation gate sees the missing money. Neither is papered over.
    return pages.map(
      (page) =>
        byPage.get(page.page) ?? {
          page: page.page,
          extraction: { rows: [], printedTotal: null, unreadable: [`page ${page.page}: batch request did not succeed`] },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, projectedCostUsd: 0 },
          model: this.model,
        },
    );
  }

  /** Poll until the API says the batch ended. Past the deadline something is wrong, not slow. */
  async #awaitCompletion(batchId: string): Promise<string> {
    const deadline = Date.now() + this.#batchTimeoutMs;
    for (;;) {
      const batch = await this.#client.messages.batches.retrieve(batchId);
      if (batch.processing_status === 'ended') return batchId;
      if (Date.now() > deadline) {
        throw new Error(`batch ${batchId} still ${batch.processing_status} after ${this.#batchTimeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.#batchPollMs));
    }
  }
}

/** Concatenate the text blocks of a reply. Constrained decoding puts the JSON in these. */
function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
