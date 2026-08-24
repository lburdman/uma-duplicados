import type { RawRow, DocumentTotals } from './table.ts';
import { readTable } from './table.ts';
import type { TextExtractor } from './ports.ts';
import type { Logger } from '../observability/logger.ts';

/**
 * The extraction port that actually matters.
 *
 * `TextExtractor` promises words with coordinates, and that is the right shape for
 * poppler and for OCR — both report where the ink is, and the grid is rebuilt from
 * geometry. It is the WRONG shape for a multimodal model. Ask a language model for word
 * bounding boxes and you get plausible numbers with real error, then run a geometric
 * table reconstruction on top of coordinates nobody measured. The model does not read
 * ink; it reads the picture and tells you what the table says.
 *
 * So the abstraction that is genuinely agnostic to the method sits one level up: give me
 * the rows of this document, however you got them. Geometry is one implementation.
 * A multimodal model is another. They do not share an output shape below this line, and
 * pretending they do is where these designs go wrong.
 */
export interface ReadResult {
  readonly rows: readonly RawRow[];
  readonly printedTotals: DocumentTotals;
  readonly pageCount: number;
  /** Pages that yielded no rows at all. What a fallback tier is offered. */
  readonly pagesWithoutRows: readonly number[];
}

export interface DocumentReader {
  /** Recorded on every document, so an auditor knows what produced the bytes. */
  readonly id: string;
  readonly version: string;
  read(document: string, pdfPath: string): Promise<ReadResult>;
}

/**
 * Words in, rows out. Wraps any `TextExtractor` and runs the geometric reconstruction.
 * This is the default and the only tier whose rows trace back to measured coordinates.
 */
export class GeometricDocumentReader implements DocumentReader {
  readonly id: string;
  readonly version: string;
  readonly #extractor: TextExtractor;

  constructor(extractor: TextExtractor) {
    this.#extractor = extractor;
    this.id = `geometry(${extractor.id})`;
    this.version = extractor.version;
  }

  async read(document: string, pdfPath: string): Promise<ReadResult> {
    const pages = await this.#extractor.extract(pdfPath);
    const table = readTable(document, pages, {
      positionTolerance: this.#extractor.positionTolerance,
    });
    const withRows = new Set(table.rows.map((r) => r.page));
    return {
      rows: table.rows,
      printedTotals: table.printedTotals,
      pageCount: pages.length,
      pagesWithoutRows: pages.map((p) => p.page).filter((page) => !withRows.has(page)),
    };
  }
}

export interface ChainedReaderOptions {
  readonly readers: readonly { readonly id: string; readonly build: () => Promise<DocumentReader> }[];
  readonly logger: Logger;
}

/**
 * Try readers in order; each one is offered only the pages the previous ones left empty.
 *
 * Per page rather than per document, for the same reason the OCR fallback is per page:
 * the realistic failure is one bad page in a batch of 146, and a document-level switch
 * either reprocesses everything to rescue one page or loses it.
 *
 * Readers are built lazily and a build failure is not fatal — a tier that cannot stand
 * up (not a Mac, no API key) degrades to a log line and the chain moves on. The chain
 * never fails a document because a fallback was unavailable.
 */
export class ChainedDocumentReader implements DocumentReader {
  readonly id: string;
  readonly version = 'chain/v1';
  readonly #options: ChainedReaderOptions;
  readonly #built = new Map<string, DocumentReader | null>();
  #tiersUsed: string[] = [];

  constructor(options: ChainedReaderOptions) {
    this.#options = options;
    this.id = `chain(${options.readers.map((r) => r.id).join(' → ')})`;
  }

  /** Which tiers actually produced rows on the last document. Reported, not guessed. */
  get tiersUsed(): readonly string[] {
    return this.#tiersUsed;
  }

  async read(document: string, pdfPath: string): Promise<ReadResult> {
    const { logger } = this.#options;
    let merged: RawRow[] = [];
    let printedTotals: DocumentTotals = { derechos: null, honorarios: null, total: null };
    let pageCount = 0;
    let pending: number[] | null = null;
    this.#tiersUsed = [];

    for (const tier of this.#options.readers) {
      if (pending !== null && pending.length === 0) break;

      const reader = await this.#resolve(tier);
      if (!reader) continue;

      const result = await reader.read(document, pdfPath);
      pageCount = Math.max(pageCount, result.pageCount);
      if (printedTotals.total === null) printedTotals = result.printedTotals;

      // First tier takes everything; later tiers only fill the gaps.
      const accepted =
        pending === null ? [...result.rows] : result.rows.filter((r) => pending!.includes(r.page));
      if (accepted.length > 0) {
        merged.push(...accepted);
        this.#tiersUsed.push(tier.id);
      }

      const rescued = new Set(accepted.map((r) => r.page));
      pending =
        pending === null
          ? [...result.pagesWithoutRows]
          : pending.filter((page) => !rescued.has(page));

      if (pending.length > 0 && tier !== this.#options.readers[this.#options.readers.length - 1]) {
        logger.info('pages still empty, offering them to the next tier', {
          tier: tier.id,
          pages: pending,
        });
      }
    }

    // Document order, not tier order: the auditor reads the PDF top to bottom.
    merged = merged.sort(
      (a, b) => a.page - b.page || a.cells.nroInterno.localeCompare(b.cells.nroInterno),
    );

    return { rows: merged, printedTotals, pageCount, pagesWithoutRows: pending ?? [] };
  }

  async #resolve(tier: { id: string; build: () => Promise<DocumentReader> }): Promise<DocumentReader | null> {
    if (this.#built.has(tier.id)) return this.#built.get(tier.id) ?? null;
    try {
      const reader = await tier.build();
      this.#built.set(tier.id, reader);
      return reader;
    } catch (error) {
      this.#built.set(tier.id, null);
      this.#options.logger.warn('extraction tier unavailable, skipping it', {
        tier: tier.id,
        reason: String(error),
      });
      return null;
    }
  }
}
