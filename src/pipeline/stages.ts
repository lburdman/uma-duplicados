import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectDuplicates } from '../detection/detect.ts';
import type { DetectionResult } from '../detection/detect.ts';
import { canonicalizeDescriptions } from '../extraction/canonicalize-descriptions.ts';
import { extractDocument } from '../extraction/extract-document.ts';
import type { DocumentExtraction, DocumentReport } from '../extraction/extract-document.ts';
import type { DocumentReader } from '../extraction/document-reader.ts';
import type { LlmProvider } from '../llm/ports.ts';
import type { Logger } from '../observability/logger.ts';
import { projectFindings, projectItems } from '../persistence/projections.ts';
import type { Repository } from '../persistence/repository.ts';

/**
 * Three stages, one direction, SQLite as the boundary between each pair.
 *
 *   1. extract  PDFs        -> documents, items, unextracted_items
 *   2. detect   items (SQL) -> findings, finding_items, finding_traces, decisions
 *   3. report   SQL         -> items.json, hallazgos.json
 *
 * The important word is *boundary*. Stage 2 does not receive stage 1's in-memory
 * result; it reads the rows back out of the database. That costs one query and buys
 * three things:
 *
 *   - Detection is reproducible without a PDF. Change a rule, run stage 2 again, and
 *     you are adjudicating exactly the bytes an auditor would see.
 *   - Anything lost or mangled in persistence is caught by the detector, not
 *     discovered later in a report nobody diffed.
 *   - Each stage is separately runnable and separately idempotent, so a failure in one
 *     does not force redoing the others.
 *
 * Every stage is a plain function over a repository. Nothing here opens a database or
 * decides where the output goes; the composition root does that.
 */

export interface ExtractionSummary {
  readonly reports: readonly DocumentReport[];
  readonly itemCount: number;
  readonly unextractedCount: number;
  readonly extractorId: string;
  readonly extractorVersion: string;
  /**
   * Wall time of the PDF reading loop only — not the database write.
   *
   * Measured because extraction has no API cost — nothing leaves the machine — and a
   * cost report that only counts API dollars would make this stage look free. It is not
   * free, it is just billed in CPU: at a million pages a day that is the line item that
   * decides the infrastructure.
   *
   * The persistence write is deliberately outside the measurement. It scales with rows,
   * not with pages, so folding it in would inflate a per-page figure with work that does
   * not vary per page — and the per-page figure is the one used to project a million.
   */
  readonly elapsedMs: number;
  readonly pageCount: number;
}

/**
 * Stage 1 — read the lot into structured rows.
 *
 * Documents are processed in sorted filename order so that every "first by document"
 * tie-break downstream is the same on any filesystem.
 */
export async function runExtraction(
  lotDir: string,
  reader: DocumentReader,
  repo: Repository,
  logger: Logger,
): Promise<ExtractionSummary> {
  const entries = await readdir(lotDir);
  const pdfs = entries.filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (pdfs.length === 0) throw new Error(`No PDF files found in ${lotDir}`);

  logger.info('lot detected', { directory: lotDir, documents: pdfs.length });

  const extractions: DocumentExtraction[] = [];
  const startedAt = performance.now();
  for (const pdf of pdfs) {
    extractions.push(await extractDocument(join(lotDir, pdf), reader, logger));
  }
  const elapsedMs = Math.round(performance.now() - startedAt);

  // Lot-level normalization belongs to extraction, not detection: it is about reading
  // the page correctly, and it needs every document to vote. See ADR 0002.
  const items = canonicalizeDescriptions(extractions.flatMap((e) => [...e.items]));

  repo.transaction(() => {
    for (const extraction of extractions) {
      repo.saveDocument(extraction.report);
      for (const entry of extraction.unextracted) repo.saveUnextracted(entry);
    }
    for (const item of items) repo.saveItem(item);
  });

  return {
    reports: extractions.map((e) => e.report),
    itemCount: items.length,
    unextractedCount: extractions.reduce((acc, e) => acc + e.unextracted.length, 0),
    extractorId: reader.id,
    extractorVersion: reader.version,
    elapsedMs,
    pageCount: extractions.reduce((acc, e) => acc + e.report.pageCount, 0),
  };
}

export interface DetectionStageResult extends DetectionResult {
  readonly retracted: number;
}

/**
 * Stage 2 — adjudicate what is already stored.
 *
 * Takes no lot directory and no extractor. It cannot reach a PDF even if it wanted to,
 * which is the guarantee: whatever it decides, it decided from the persisted data.
 */
export async function runDetection(
  repo: Repository,
  provider: LlmProvider,
  logger: Logger,
  decidedAt: string,
): Promise<DetectionStageResult> {
  const items = repo.loadItems();
  if (items.length === 0) {
    throw new Error('No items in the database. Run extraction first.');
  }

  // The extractor that produced these rows is a property of the data, read back from
  // the documents table — not something this stage is told.
  const reports = repo.loadDocumentReports();
  const first = reports[0];
  if (!first) throw new Error('Items exist with no document. The database is inconsistent.');

  logger.info('detection input loaded from database', {
    items: items.length,
    documents: reports.length,
  });

  const detection = await detectDuplicates({
    items,
    provider,
    logger,
    extractorId: first.extractorId,
    extractorVersion: first.extractorVersion,
    decidedAt,
  });

  let retracted = 0;
  repo.transaction(() => {
    for (const finding of detection.findings) repo.saveFinding(finding);
    for (const decision of detection.decisions) repo.saveDecision(decision);
    // Retraction is scoped to the documents whose items we just adjudicated, so a run
    // over one lot never withdraws findings belonging to another.
    retracted = repo.retractStaleFindings(
      detection.findings.map((f) => f.findingId),
      [...new Set(items.map((i) => i.documentId))],
    );
  });

  if (retracted > 0) logger.info('retracted findings this run no longer supports', { retracted });

  return { ...detection, retracted };
}

export interface ReportPaths {
  readonly itemsPath: string;
  readonly findingsPath: string;
}

/**
 * Stage 3 — project the stored rows back out as JSON.
 *
 * Reads only from SQL. That is what makes byte-identical output evidence that the
 * upserts landed on the same rows, rather than evidence that the code is deterministic.
 */
export async function runReport(repo: Repository, outDir: string): Promise<ReportPaths> {
  await mkdir(outDir, { recursive: true });
  const itemsPath = join(outDir, 'items.json');
  const findingsPath = join(outDir, 'hallazgos.json');
  await writeFile(itemsPath, `${JSON.stringify(projectItems(repo), null, 2)}\n`, 'utf8');
  await writeFile(findingsPath, `${JSON.stringify(projectFindings(repo), null, 2)}\n`, 'utf8');
  return { itemsPath, findingsPath };
}
