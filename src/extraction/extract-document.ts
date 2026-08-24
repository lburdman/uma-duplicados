import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseAmountToCents } from '../domain/money.ts';
import type { Logger } from '../observability/logger.ts';
import type { BillingItem, UnextractedItem } from './billing-item.ts';
import { parseRow } from './parse-row.ts';
import type { DocumentReader } from './document-reader.ts';

export interface DocumentReport {
  /** sha256 prefix of the file bytes. Identity is the content, not the file name. */
  readonly documentId: string;
  readonly document: string;
  readonly pageCount: number;
  readonly rowCount: number;
  readonly itemCount: number;
  readonly unextractedCount: number;
  /**
   * Sum of the Total column over EVERY row we read off the grid, whether or not the
   * row survived normalization. This is what reconciles: it measures the reader, not
   * the normalizer, which is the only way to prove we did not drop a row.
   */
  readonly readTotalCents: number;
  /** Sum over items that normalized cleanly. */
  readonly extractedTotalCents: number;
  /** Money sitting in rows we refused to normalize. Reported, never hidden. */
  readonly unextractedTotalCents: number;
  /** The TOTAL: line the provider printed on the document itself. */
  readonly printedTotalCents: number | null;
  /** read - printed. Zero means we lost nothing and invented nothing. */
  readonly reconciliationDeltaCents: number | null;
  readonly reconciled: boolean;
  readonly extractorId: string;
  readonly extractorVersion: string;
}

export interface DocumentExtraction {
  readonly report: DocumentReport;
  readonly items: readonly BillingItem[];
  readonly unextracted: readonly UnextractedItem[];
}

export async function documentIdOf(pdfPath: string): Promise<string> {
  const bytes = await readFile(pdfPath);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * The reconciliation gate.
 *
 * Every rendición prints its own grand total. That is a checksum the provider
 * signed, and it is the only ground truth available without a human reading 146
 * pages. If the sum of what we extracted equals it to the cent, we did not drop a
 * row and we did not double-count one. If it does not, we say so out loud rather
 * than shipping a number that looks fine.
 */
export async function extractDocument(
  pdfPath: string,
  reader: DocumentReader,
  logger: Logger,
): Promise<DocumentExtraction> {
  const document = basename(pdfPath);
  const documentId = await documentIdOf(pdfPath);
  const table = await reader.read(document, pdfPath);

  if (table.pagesWithoutRows.length > 0) {
    logger.warn('pages that produced no rows in any extraction tier', {
      document,
      pages: table.pagesWithoutRows,
    });
  }

  const items: BillingItem[] = [];
  const unextracted: UnextractedItem[] = [];
  for (const row of table.rows) {
    const outcome = parseRow(row, documentId);
    if (outcome.ok) items.push(outcome.item);
    else unextracted.push(outcome.unextracted);
  }

  const extractedTotalCents = items.reduce((acc, item) => acc + item.totalCents, 0);
  const unextractedTotalCents = unextracted.reduce((acc, u) => acc + (u.totalCents ?? 0), 0);
  const readTotalCents = extractedTotalCents + unextractedTotalCents;
  const printedTotalCents = table.printedTotals.total
    ? parseAmountToCents(table.printedTotals.total)
    : null;
  const reconciliationDeltaCents =
    printedTotalCents === null ? null : readTotalCents - printedTotalCents;

  const report: DocumentReport = {
    documentId,
    document,
    pageCount: table.pageCount,
    rowCount: table.rows.length,
    itemCount: items.length,
    unextractedCount: unextracted.length,
    readTotalCents,
    extractedTotalCents,
    unextractedTotalCents,
    printedTotalCents,
    reconciliationDeltaCents,
    reconciled: reconciliationDeltaCents === 0,
    extractorId: reader.id,
    extractorVersion: reader.version,
  };

  if (printedTotalCents === null) {
    // Not the same thing as failing to reconcile, and the log must not say it is: a
    // page fragment or a document without a TOTAL: line simply offers nothing to check
    // against. `reconciled` stays false because unproven is not proven.
    logger.warn('document has no printed grand total, so extraction could not be verified', {
      document,
      readTotalCents,
    });
  } else if (!report.reconciled) {
    logger.warn('document did not reconcile against its printed total', {
      document,
      readTotalCents,
      printedTotalCents,
      deltaCents: reconciliationDeltaCents,
    });
  } else {
    logger.info('document reconciled', {
      document,
      pages: table.pageCount,
      rows: table.rows.length,
      items: items.length,
      unextracted: unextracted.length,
    });
  }

  return { report, items, unextracted };
}
