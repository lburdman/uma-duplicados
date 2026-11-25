import { basename } from 'node:path';
import { readTable } from '../extraction/table.ts';
import { parseRow } from '../extraction/parse-row.ts';
import { PopplerTextExtractor } from '../extraction/poppler-extractor.ts';
import { VisionOcrExtractor } from '../extraction/vision-ocr-extractor.ts';
import { parseAmountToCents, formatCents } from '../domain/money.ts';
import { handleHelp } from './help.ts';

/**
 * `pnpm ocr <pdf> [page]`
 *
 * Exercises the OCR path on demand and puts it side by side with the text layer on the
 * same page. Nothing in the lot needs OCR — every page has embedded text — so without a
 * command like this the fallback would be code nobody has ever seen run, which is the
 * same as code that does not work.
 *
 * It reports agreement on the fields that matter for a debit, not on raw characters:
 * an OCR engine that renders the description slightly differently is fine, one that
 * reads 340213 as 340218 is not.
 */
handleHelp('ocr');

const [, , pdfPath, pageArg] = process.argv;
if (!pdfPath) {
  process.stderr.write('usage: pnpm ocr <pdf> [page]   (pnpm ocr --help para el detalle)\n');
  process.exit(2);
}
const targetPage = pageArg ? Number(pageArg) : 1;

const poppler = await PopplerTextExtractor.detect();
const vision = await VisionOcrExtractor.detect();

process.stdout.write(`\n  documento   ${basename(pdfPath)}\n  página      ${targetPage}\n`);
process.stdout.write(`  texto       ${poppler.id}@${poppler.version}\n`);
process.stdout.write(`  ocr         ${vision.id}@${vision.version}\n\n`);

const started = Date.now();
const textPages = await poppler.extract(pdfPath);
const textElapsed = Date.now() - started;

const ocrStarted = Date.now();
const ocrPages = await vision.extract(pdfPath);
const ocrElapsed = Date.now() - ocrStarted;

const textPage = textPages.find((p) => p.page === targetPage);
const ocrPage = ocrPages.find((p) => p.page === targetPage);
if (!textPage || !ocrPage) {
  process.stderr.write(`page ${targetPage} not found (document has ${textPages.length} pages)\n`);
  process.exit(1);
}

const document = basename(pdfPath);
const textRows = readTable(document, [textPage], { positionTolerance: poppler.positionTolerance }).rows;
const ocrRows = readTable(document, [ocrPage], { positionTolerance: vision.positionTolerance }).rows;

const textItems = textRows.map((r) => parseRow(r, 'text')).filter((o) => o.ok);
const ocrItems = ocrRows.map((r) => parseRow(r, 'ocr')).filter((o) => o.ok);

const sum = (rows: readonly (typeof textRows)[number][]): number =>
  rows.reduce((acc, r) => acc + (parseAmountToCents(r.cells.total) ?? 0), 0);

process.stdout.write(`                        capa de texto        OCR
  palabras              ${String(textPage.words.length).padEnd(20)} ${ocrPage.words.length}
  filas reconstruidas   ${String(textRows.length).padEnd(20)} ${ocrRows.length}
  ítems parseados       ${String(textItems.length).padEnd(20)} ${ocrItems.length}
  suma de la columna
  Total de la página    ${formatCents(sum(textRows)).padEnd(20)} ${formatCents(sum(ocrRows))}
  tiempo (documento)    ${String(textElapsed + 'ms').padEnd(20)} ${ocrElapsed}ms

`);

// Field-level agreement, keyed by internal number: the number an auditor looks for.
const byNro = new Map(textRows.map((r) => [r.cells.nroInterno, r]));
let compared = 0;
const mismatches: string[] = [];
for (const row of ocrRows) {
  const reference = byNro.get(row.cells.nroInterno);
  if (!reference) {
    mismatches.push(`  fila ${row.cells.nroInterno || '(sin nro)'} sólo la ve el OCR`);
    continue;
  }
  compared++;
  for (const field of ['afiliado', 'fecha', 'total'] as const) {
    if (row.cells[field] !== reference.cells[field]) {
      mismatches.push(`  fila ${row.cells.nroInterno} · ${field}: texto "${reference.cells[field]}" vs ocr "${row.cells[field]}"`);
    }
  }
}
const missed = textRows.filter((r) => !ocrRows.some((o) => o.cells.nroInterno === r.cells.nroInterno));
for (const row of missed) mismatches.push(`  fila ${row.cells.nroInterno} el OCR no la encontró`);

const agreement = compared === 0 ? 0 : (compared * 3 - mismatches.length) / (compared * 3);
process.stdout.write(`  filas comparables     ${compared} de ${textRows.length}
  coincidencia en
  afiliado/fecha/total  ${(Math.max(0, agreement) * 100).toFixed(1)} %
`);

if (mismatches.length > 0) {
  process.stdout.write(`\n  Diferencias (${mismatches.length}):\n${mismatches.slice(0, 25).join('\n')}\n`);
  if (mismatches.length > 25) process.stdout.write(`  ... y ${mismatches.length - 25} más\n`);
}
process.stdout.write('\n');
