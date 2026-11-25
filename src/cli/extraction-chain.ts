import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { formatCents } from '../domain/money.ts';
import { ChainedDocumentReader, GeometricDocumentReader } from '../extraction/document-reader.ts';
import type { DocumentReader } from '../extraction/document-reader.ts';
import { extractDocument } from '../extraction/extract-document.ts';
import { LlmDocumentReader } from '../extraction/llm-document-reader.ts';
import { PopplerTextExtractor } from '../extraction/poppler-extractor.ts';
import { VisionOcrExtractor } from '../extraction/vision-ocr-extractor.ts';
import { MockPageExtractionProvider } from '../llm/mock-page-extraction-provider.ts';
import { createLogger } from '../observability/logger.ts';
import { handleHelp } from './help.ts';

const run = promisify(execFile);

/**
 * `pnpm ocr:fallback <pdf> [page] [--no-vision]`
 *
 * Walks all three extraction tiers down a page that the text layer cannot read at all.
 *
 * No page in this lot needs anything but tier 1, so the only honest way to exercise the
 * lower tiers is to manufacture a page that does: rasterize a real page and wrap the
 * image back into a PDF, which strips the text layer while keeping the content identical.
 * Tier 1 then reads zero words from it and the chain has to earn the rows.
 *
 * With `--no-vision` the second tier is skipped too, which is the scenario tier 3 exists
 * for: no text layer, no local OCR, and the multimodal model as the last resort.
 */
handleHelp('ocr:fallback');

const args = process.argv.slice(2);
const noVision = args.includes('--no-vision');
const [pdfPath, pageArg] = args.filter((a) => !a.startsWith('--'));
if (!pdfPath) {
  process.stderr.write('usage: pnpm ocr:fallback <pdf> [page] [--no-vision]   (--help para el detalle)\n');
  process.exit(2);
}
const targetPage = pageArg ?? '1';

const logger = createLogger();
const workDir = await mkdtemp(join(tmpdir(), 'uma-fallback-'));

try {
  process.stdout.write(`\n  Fabricando una página sin capa de texto desde ${basename(pdfPath)} p.${targetPage}\n`);
  await run('pdftoppm', ['-r', '200', '-png', '-f', targetPage, '-l', targetPage, pdfPath, join(workDir, 'page')]);
  const png = (await readdir(workDir)).find((f) => f.endsWith('.png'));
  if (!png) throw new Error('rasterization produced no image');
  const scanned = join(workDir, 'scanned.pdf');
  await run('sips', ['-s', 'format', 'pdf', join(workDir, png), '--out', scanned]);

  const poppler = await PopplerTextExtractor.detect();
  const bare = await poppler.extract(scanned);
  process.stdout.write(`  la capa de texto de esa página tiene ${bare[0]?.words.length ?? 0} palabras\n`);
  if (noVision) process.stdout.write('  tier 2 (OCR local) deshabilitado con --no-vision\n');
  process.stdout.write('\n');

  const llmReader = new LlmDocumentReader({ provider: new MockPageExtractionProvider(), logger });
  const tiers: { id: string; build: () => Promise<DocumentReader> }[] = [
    { id: 'text-layer', build: async () => new GeometricDocumentReader(poppler) },
  ];
  if (!noVision) {
    tiers.push({
      id: 'local-ocr',
      build: async () => new GeometricDocumentReader(await VisionOcrExtractor.detect()),
    });
  }
  tiers.push({ id: 'multimodal-llm', build: async () => llmReader });

  const chain = new ChainedDocumentReader({ readers: tiers, logger });
  const started = Date.now();
  const rescued = await extractDocument(scanned, chain, logger);
  const elapsed = Date.now() - started;

  const reference = await extractDocument(pdfPath, new GeometricDocumentReader(poppler), logger);
  const referenceRows = reference.items.filter((i) => i.page === Number(targetPage));

  process.stdout.write(`
                        original (texto)     escaneado (cadena)
  filas                 ${String(referenceRows.length).padEnd(20)} ${rescued.report.rowCount}
  ítems                 ${String(referenceRows.length).padEnd(20)} ${rescued.report.itemCount}
  no extraídos          ${'0'.padEnd(20)} ${rescued.report.unextractedCount}
  suma de Total         ${formatCents(referenceRows.reduce((a, i) => a + i.totalCents, 0)).padEnd(20)} ${formatCents(rescued.report.readTotalCents)}

  cadena                ${chain.id}
  tiers que produjeron  ${chain.tiersUsed.join(', ') || '(ninguno)'}
  tokens del tier 3     ${llmReader.usage.inputTokens} in / ${llmReader.usage.outputTokens} out
  costo real tier 3     USD ${llmReader.usage.costUsd.toFixed(6)}  (mock)
  a precio de lista     USD ${(llmReader.usage.projectedCostUsd ?? 0).toFixed(6)}
  tiempo                ${elapsed}ms

`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
