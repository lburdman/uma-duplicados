import { z } from 'zod/v4';
import type { LlmUsage } from './ports.ts';

/**
 * Port for reading a page image with a multimodal model.
 *
 * Deliberately NOT shaped like `TextExtractor`. A model does not report where the ink
 * is; it reports what the table says. Asking it for word bounding boxes gets plausible
 * numbers with real error, and the geometric reconstruction would then run on
 * coordinates nobody measured. So this port returns cells, and the tier that uses it
 * skips geometry entirely.
 */
export interface PageImage {
  readonly page: number;
  readonly base64: string;
  readonly mediaType: 'image/png';
}

/** Exactly the twelve columns of the rendición, as strings. Parsing stays downstream. */
export const ExtractedRowSchema = z.object({
  nroInterno: z.string(),
  afiliado: z.string(),
  bono: z.string(),
  profesional: z.string(),
  servicio: z.string(),
  fecha: z.string(),
  prestacion: z.string(),
  cantidad: z.string(),
  derechos: z.string(),
  honorarios: z.string(),
  total: z.string(),
});
export const PageExtractionSchema = z.object({
  rows: z.array(ExtractedRowSchema),
  /** The TOTAL: line, when the page carries one. Null on every page but the last. */
  printedTotal: z.string().nullable(),
  /**
   * What the model could not read. The instruction is explicit that a cell it cannot
   * read must come back empty, never guessed — the same rule the rest of the pipeline
   * follows, applied to the one component that is capable of inventing.
   */
  unreadable: z.array(z.string()),
});
export type PageExtraction = z.infer<typeof PageExtractionSchema>;

export const PAGE_EXTRACTION_JSON_SCHEMA = z.toJSONSchema(PageExtractionSchema);

export interface PageExtractionResult {
  readonly page: number;
  readonly extraction: PageExtraction;
  readonly usage: LlmUsage;
  readonly model: string;
}

export interface PageExtractionProvider {
  readonly id: string;
  readonly model: string;
  /**
   * `sync` bills at list price and answers in seconds.
   * `batch` bills at half and answers within the hour. See ADR 0007 for why extraction
   * is the one stage where that trade is obviously worth taking.
   */
  readonly mode: 'sync' | 'batch';
  /**
   * Every page at once, not one call per page.
   *
   * The signature is plural because the Batch API needs the whole set up front, and a
   * per-page signature would have forced a rewrite to adopt it. A sync provider just
   * loops. Shaping the interface around the more demanding of the two costs nothing and
   * keeps the cheaper path reachable.
   */
  extractPages(pages: readonly PageImage[]): Promise<PageExtractionResult[]>;
}

export function parsePageExtraction(raw: string): PageExtraction {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`page extraction reply was not JSON: ${raw.slice(0, 200)}`);
  }
  const result = PageExtractionSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`page extraction reply did not match the schema: ${result.error.message}`);
  }
  return result.data;
}
