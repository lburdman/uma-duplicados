import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LlmUsage } from '../llm/ports.ts';
import type { PageExtractionProvider, PageImage } from '../llm/page-extraction.ts';
import type { Logger } from '../observability/logger.ts';
import type { DocumentReader, ReadResult } from './document-reader.ts';
import { COLUMNS, emptyCells } from './table.ts';
import type { RawRow } from './table.ts';

const run = promisify(execFile);

/**
 * Last extraction tier: hand the page image to a multimodal model.
 *
 * 150 dpi, not the 300 the OCR tier uses. A vision model resamples the image to its own
 * grid anyway, so the extra pixels buy nothing and cost tokens — an image is billed at
 * roughly width*height/750 tokens, so doubling the resolution roughly quadruples the
 * price of the one tier that bills per page.
 *
 * Rows produced here are tagged `GENERATIVE`. That is not bookkeeping: it is what keeps
 * a hallucinated charge from becoming a debit, because `parseRow` penalises the source
 * below the confidence floor that detection requires.
 */
const RENDER_DPI = 150;

export interface LlmDocumentReaderOptions {
  readonly provider: PageExtractionProvider;
  readonly logger: Logger;
  readonly dpi?: number;
}

export interface LlmReaderUsage extends LlmUsage {
  readonly pages: number;
}

export class LlmDocumentReader implements DocumentReader {
  readonly id: string;
  readonly version: string;
  readonly #provider: PageExtractionProvider;
  readonly #logger: Logger;
  readonly #dpi: number;
  #usage: LlmReaderUsage = { pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, projectedCostUsd: 0 };

  constructor(options: LlmDocumentReaderOptions) {
    this.#provider = options.provider;
    this.#logger = options.logger;
    this.#dpi = options.dpi ?? RENDER_DPI;
    this.id = `llm(${options.provider.id})`;
    this.version = `${options.provider.model}/${options.provider.mode}`;
  }

  get usage(): LlmReaderUsage {
    return this.#usage;
  }

  async read(document: string, pdfPath: string): Promise<ReadResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'uma-llm-'));
    try {
      await run('pdftoppm', ['-r', String(this.#dpi), '-png', pdfPath, join(workDir, 'page')], {
        maxBuffer: 256 * 1024 * 1024,
      });
      const files = (await readdir(workDir)).filter((f) => f.endsWith('.png')).sort();
      const images: PageImage[] = await Promise.all(
        files.map(async (file, index) => ({
          page: index + 1,
          mediaType: 'image/png' as const,
          base64: (await readFile(join(workDir, file))).toString('base64'),
        })),
      );

      this.#logger.info('sending pages to the multimodal tier', {
        document,
        pages: images.length,
        model: this.#provider.model,
        mode: this.#provider.mode,
      });

      const results = await this.#provider.extractPages(images);

      const rows: RawRow[] = [];
      let printedTotal: string | null = null;
      const pagesWithoutRows: number[] = [];

      for (const result of results) {
        this.#usage = {
          pages: this.#usage.pages + 1,
          inputTokens: this.#usage.inputTokens + result.usage.inputTokens,
          outputTokens: this.#usage.outputTokens + result.usage.outputTokens,
          costUsd: this.#usage.costUsd + result.usage.costUsd,
          projectedCostUsd: (this.#usage.projectedCostUsd ?? 0) + (result.usage.projectedCostUsd ?? 0),
        };

        if (result.extraction.printedTotal) printedTotal = result.extraction.printedTotal;
        if (result.extraction.unreadable.length > 0) {
          this.#logger.warn('multimodal tier could not read part of a page', {
            document,
            page: result.page,
            unreadable: result.extraction.unreadable.length,
          });
        }
        if (result.extraction.rows.length === 0) {
          pagesWithoutRows.push(result.page);
          continue;
        }

        for (const extracted of result.extraction.rows) {
          const cells = emptyCells();
          for (const column of COLUMNS) {
            const value = (extracted as Record<string, string | undefined>)[column.key];
            if (typeof value === 'string') cells[column.key] = value.trim();
          }
          rows.push({
            source: 'GENERATIVE',
            document,
            page: result.page,
            pages: [result.page],
            cells,
            // Geometry-only concepts. A generated row has no words to orphan and no
            // overlapping runs to separate, so reporting zero here is accurate, not a
            // default: the doubt about this row lives in its `source`, not in these.
            orphanWords: [],
            residueCount: 0,
            ambiguousResidue: false,
          });
        }
      }

      return {
        rows,
        printedTotals: { derechos: null, honorarios: null, total: printedTotal },
        pageCount: images.length,
        pagesWithoutRows,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
