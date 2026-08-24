import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ChainedDocumentReader, GeometricDocumentReader } from '../extraction/document-reader.ts';
import type { DocumentReader } from '../extraction/document-reader.ts';
import { LlmDocumentReader } from '../extraction/llm-document-reader.ts';
import { PopplerTextExtractor } from '../extraction/poppler-extractor.ts';
import { VisionOcrExtractor } from '../extraction/vision-ocr-extractor.ts';
import { AnthropicPageExtractionProvider } from '../llm/anthropic-page-extraction-provider.ts';
import { MockPageExtractionProvider } from '../llm/mock-page-extraction-provider.ts';
import { AnthropicLlmProvider } from '../llm/anthropic-provider.ts';
import { MockLlmProvider } from '../llm/mock-provider.ts';
import type { LlmProvider } from '../llm/ports.ts';
import { createLogger } from '../observability/logger.ts';
import type { Logger } from '../observability/logger.ts';
import { Repository } from '../persistence/repository.ts';
import { runDetection, runExtraction, runReport } from './stages.ts';
import type { DetectionStageResult, ExtractionSummary, ReportPaths } from './stages.ts';

/**
 * Composition root.
 *
 * The only place that opens a database, picks a provider or decides where files land.
 * Every stage below it is a pure-ish function over injected collaborators, which is
 * what lets the tests run the real pipeline with a deterministic provider and a
 * throwaway output directory.
 */
export interface PipelineOptions {
  readonly lotDir?: string;
  readonly outDir?: string;
  readonly dbPath?: string;
  readonly logger?: Logger;
  readonly provider?: LlmProvider;
  readonly reader?: DocumentReader;
  /**
   * Frozen decision timestamp.
   *
   * A wall-clock `new Date()` here would put a different string in every trace and the
   * output would differ between runs — idempotency lost to a field nobody reads. The
   * lot is the unit of work, so the timestamp is an input to it, not a side effect.
   */
  readonly decidedAt?: string;
}

/** Row count per data table. Two runs of the same lot must produce identical numbers. */
export type TableCounts = Record<(typeof COUNTED_TABLES)[number], number>;

const COUNTED_TABLES = [
  'documents',
  'items',
  'unextracted_items',
  'findings',
  'finding_items',
  'finding_traces',
  'decisions',
] as const;

export interface PipelineResult {
  readonly extraction: ExtractionSummary;
  readonly detection: DetectionStageResult;
  readonly report: ReportPaths;
  readonly counts: TableCounts;
}

const DEFAULT_DECIDED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Where output goes. OUT_DIR overrides the default so a validation run can be pointed
 * at a scratch directory instead of overwriting the real one.
 */
export function resolvePaths(options: PipelineOptions): { outDir: string; dbPath: string } {
  const outDir = resolve(options.outDir ?? process.env.OUT_DIR ?? 'out');
  return { outDir, dbPath: resolve(options.dbPath ?? join(outDir, 'hallazgos.db')) };
}

/**
 * The extraction chain: three tiers, cheapest and most trustworthy first.
 *
 *   1. embedded text layer   free, exact coordinates, bit-reproducible
 *   2. local OCR (Vision)    free, on-device, ~450x slower, coordinates inferred
 *   3. multimodal model      per-page price, no coordinates at all, can hallucinate
 *
 * The ordering IS the cost argument and the trust argument at once, and they happen to
 * agree: the tier that bills per page is also the one whose output is generated rather
 * than measured, so it is the last one asked. Each tier is offered only the pages the
 * previous ones left empty, and a tier that cannot stand up degrades to a log line.
 *
 * Tiers 1 and 2 share an output shape (words with coordinates) so they are chained
 * inside a single geometric reader and a page can be swapped between them freely.
 * Tier 3 does not — a model returns rows, not ink — so it can only substitute whole
 * pages, which is exactly what the chain does.
 *
 * Env: OCR_FALLBACK=off disarms tier 2, LLM_OCR=off disarms tier 3,
 * LLM_OCR=anthropic swaps the mock for the real client, EXTRACTOR=ocr|llm forces one
 * tier for the whole lot (validation modes, not production). See ADR 0007.
 */
export async function selectReader(logger: Logger): Promise<DocumentReader> {
  const forced = process.env.EXTRACTOR;
  if (forced === 'ocr') {
    logger.warn('forcing OCR for every page (EXTRACTOR=ocr) — this is a validation mode');
    return new GeometricDocumentReader(await VisionOcrExtractor.detect());
  }
  if (forced === 'llm') {
    logger.warn('forcing the multimodal tier for every page (EXTRACTOR=llm) — validation mode');
    return buildLlmReader(logger);
  }

  const tiers: { id: string; build: () => Promise<DocumentReader> }[] = [
    {
      id: 'text-layer',
      build: async () => new GeometricDocumentReader(await PopplerTextExtractor.detect()),
    },
  ];

  if (process.env.OCR_FALLBACK !== 'off') {
    tiers.push({
      id: 'local-ocr',
      build: async () => new GeometricDocumentReader(await VisionOcrExtractor.detect()),
    });
  }
  if (process.env.LLM_OCR !== 'off') {
    tiers.push({ id: 'multimodal-llm', build: async () => buildLlmReader(logger) });
  }

  return new ChainedDocumentReader({ readers: tiers, logger });
}

function buildLlmReader(logger: Logger): DocumentReader {
  const mode = process.env.OCR_LLM_MODE === 'batch' ? 'batch' : 'sync';
  if (process.env.LLM_OCR === 'anthropic') {
    logger.info('multimodal extraction tier: real Anthropic client', { mode });
    return new LlmDocumentReader({ provider: new AnthropicPageExtractionProvider({ mode }), logger });
  }
  logger.info('multimodal extraction tier: mock (set LLM_OCR=anthropic for the real one)', { mode });
  return new LlmDocumentReader({ provider: new MockPageExtractionProvider({ mode }), logger });
}

/**
 * The detection model.
 *
 * The mock is the default so `pnpm start ./lote` works on a machine with no API key, and
 * so the idempotency test has a deterministic layer 2. `LLM_PROVIDER=anthropic` (with a
 * key) switches to the real one; either way the finding's trace records which answered.
 */
export function selectProvider(logger: Logger): LlmProvider {
  if (process.env.LLM_PROVIDER === 'anthropic') {
    logger.info('using anthropic llm provider', { model: process.env.LLM_MODEL ?? 'claude-opus-5' });
    return new AnthropicLlmProvider();
  }
  logger.info('using mock llm provider (set LLM_PROVIDER=anthropic for the real one)');
  return new MockLlmProvider();
}

export async function withRepository<T>(
  options: PipelineOptions,
  work: (repo: Repository) => Promise<T>,
): Promise<T> {
  const { dbPath, outDir } = resolvePaths(options);
  await mkdir(outDir, { recursive: true });
  const repo = new Repository(dbPath);
  try {
    return await work(repo);
  } finally {
    repo.close();
  }
}

/** Stage 1 alone. */
export async function extractOnly(options: PipelineOptions & { lotDir: string }): Promise<ExtractionSummary> {
  const logger = options.logger ?? createLogger();
  const reader = options.reader ?? (await selectReader(logger));
  return withRepository(options, (repo) => runExtraction(options.lotDir, reader, repo, logger));
}

/** Stage 2 alone, over whatever is already stored. */
export async function detectOnly(options: PipelineOptions = {}): Promise<DetectionStageResult> {
  const logger = options.logger ?? createLogger();
  const provider = options.provider ?? selectProvider(logger);
  return withRepository(options, (repo) =>
    runDetection(repo, provider, logger, options.decidedAt ?? DEFAULT_DECIDED_AT),
  );
}

/** Stage 3 alone. */
export async function reportOnly(options: PipelineOptions = {}): Promise<ReportPaths> {
  const { outDir } = resolvePaths(options);
  return withRepository(options, (repo) => runReport(repo, outDir));
}

/** All three, in order, sharing one open database. */
export async function runPipeline(options: PipelineOptions & { lotDir: string }): Promise<PipelineResult> {
  const logger = options.logger ?? createLogger();
  const reader = options.reader ?? (await selectReader(logger));
  const provider = options.provider ?? selectProvider(logger);
  const { outDir } = resolvePaths(options);

  return withRepository(options, async (repo) => {
    const extraction = await runExtraction(options.lotDir, reader, repo, logger);
    const detection = await runDetection(repo, provider, logger, options.decidedAt ?? DEFAULT_DECIDED_AT);
    const report = await runReport(repo, outDir);
    return {
      extraction,
      detection,
      report,
      counts: Object.fromEntries(
        COUNTED_TABLES.map((table) => [table, repo.countRows(table)]),
      ) as TableCounts,
    };
  });
}
