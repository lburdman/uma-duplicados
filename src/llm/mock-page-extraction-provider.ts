import { createHash } from 'node:crypto';
import { costUsd } from './pricing.ts';
import type {
  PageExtractionProvider,
  PageExtractionResult,
  PageImage,
} from './page-extraction.ts';
import { parsePageExtraction } from './page-extraction.ts';

/**
 * Stand-in for a multimodal model, deliberately incapable of inventing a billing row.
 *
 * A mock that returned plausible rows would be worse than useless here: the whole point
 * of this tier is that its output is generated rather than measured, and a mock that
 * fabricates charges teaches exactly the wrong reflex — it would make the demo look like
 * extraction succeeded. So it returns no rows and reports every page as unreadable.
 *
 * What it does exercise is everything around the model: the request shape, the schema,
 * the token and cost accounting, the batch path, and the chain's decision to fall
 * through. That is the part worth proving without an API key.
 *
 * The token counts below are MEASURED, on page 1 of this lot at 150 dpi:
 *
 *   - the image renders at 1755x1240 and Anthropic resizes the long edge to 1568, so
 *     1568x1108 / 750 = 2.316 input tokens;
 *   - the prompt is 1.756 characters = 439 tokens;
 *   - the reply for a full 15-row page is 4.145 characters = 1.037 output tokens.
 *
 * Measuring rather than estimating matters more here than anywhere else in the project,
 * because this is the only per-page price in the pipeline and it is the number that gets
 * quoted. Intuition is badly calibrated on both halves: the image dominates the input,
 * and a full grid of transcribed rows is an order of magnitude more output than a verdict
 * — plausible-sounding round numbers land an order of magnitude low and turn a
 * USD 16.000 line item into a USD 600 one.
 */
export const MOCK_IMAGE_TOKENS = 2_316;
export const MOCK_PROMPT_TOKENS = 439;
export const MOCK_OUTPUT_TOKENS_PER_FULL_PAGE = 1_037;

export interface MockPageExtractionOptions {
  readonly mode?: 'sync' | 'batch';
  /** Priced against this model so the report shows what the real tier would cost. */
  readonly projectAs?: string;
}

export class MockPageExtractionProvider implements PageExtractionProvider {
  readonly id = 'mock-multimodal';
  readonly model = 'mock-multimodal-v1';
  readonly mode: 'sync' | 'batch';
  readonly #projectAs: string;

  constructor(options: MockPageExtractionOptions = {}) {
    this.mode = options.mode ?? 'sync';
    this.#projectAs = options.projectAs ?? 'claude-sonnet-5';
  }

  async extractPages(pages: readonly PageImage[]): Promise<PageExtractionResult[]> {
    return pages.map((page) => {
      const raw = JSON.stringify({
        rows: [],
        printedTotal: null,
        unreadable: [`page ${page.page}: mock provider does not read images`],
      });
      const inputTokens = MOCK_IMAGE_TOKENS + MOCK_PROMPT_TOKENS;
      // Priced as if the page had been read in full, even though this mock reads
      // nothing. The cost report is meant to answer "what would this tier cost", and a
      // provider that returns nothing and bills nothing answers the wrong question.
      const outputTokens = MOCK_OUTPUT_TOKENS_PER_FULL_PAGE;
      // Batch is half price. Modelled so the two modes are comparable in the report.
      const listed = costUsd(this.#projectAs, inputTokens, outputTokens);
      return {
        page: page.page,
        extraction: parsePageExtraction(raw),
        usage: {
          inputTokens,
          outputTokens,
          costUsd: 0,
          projectedCostUsd: this.mode === 'batch' ? listed / 2 : listed,
        },
        model: `${this.model}#${fingerprint(page)}`,
      };
    });
  }
}

/** Stable per-image marker, so two runs over the same lot produce identical traces. */
function fingerprint(page: PageImage): string {
  return createHash('sha256').update(page.base64).digest('hex').slice(0, 8);
}
