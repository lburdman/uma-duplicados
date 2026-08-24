import { BILLING_CODE } from '../domain/practice.ts';
import type { ExtractedPage, Word } from './ports.ts';

/**
 * Geometric reconstruction of the rendición grid.
 *
 * Three steps, in order:
 *   1. find the header line on the page and read the column anchors off it;
 *   2. cluster words into visual lines by vertical overlap;
 *   3. rebuild each cell's text runs, assign words to columns, and fold
 *      continuation lines into the row that owns them.
 *
 * Step 1 is per page on purpose: Crystal Reports re-lays the header on every page
 * and the anchors drift by a few points when the widest cell changes.
 */

export const COLUMNS = [
  { key: 'nroInterno', align: 'left', header: ['Nro.', 'Int.'] },
  { key: 'afiliado', align: 'left', header: ['Nro.', 'de', 'Afiliado'] },
  { key: 'bono', align: 'left', header: ['Nro.', 'de', 'Bono'] },
  { key: 'profesional', align: 'left', header: ['Profesional', 'Efector'] },
  { key: 'servicio', align: 'left', header: ['Servicio'] },
  { key: 'fecha', align: 'left', header: ['Fecha'] },
  { key: 'nombre', align: 'left', header: ['Apellido', 'y', 'Nombre'] },
  { key: 'prestacion', align: 'left', header: ['Prestación'] },
  { key: 'cantidad', align: 'left', header: ['Cant.'] },
  { key: 'derechos', align: 'right', header: ['Der.'] },
  { key: 'honorarios', align: 'right', header: ['Hon.'] },
  { key: 'total', align: 'right', header: ['Total'] },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];
export type Cells = Record<ColumnKey, string>;

/**
 * How a row came to exist.
 *
 * GEOMETRY means it was reconstructed from word coordinates the document itself
 * reports — poppler or OCR. Every cell traces back to ink on a page.
 *
 * GENERATIVE means a language model read an image and wrote the row. That is a
 * different epistemic status and the pipeline treats it as such: a generative row
 * carries a confidence penalty that keeps it below the finding floor, so a model that
 * hallucinates a charge cannot silently produce a debit. Raising it is a human's call.
 */
export type RowSource = 'GEOMETRY' | 'GENERATIVE';

export interface RawRow {
  readonly source: RowSource;
  readonly document: string;
  /** Page where the row STARTS. That is the page an auditor is sent to. */
  readonly page: number;
  /** Every page the row touches. A row that wraps across a page break lists both. */
  readonly pages: readonly number[];
  readonly cells: Cells;
  /** Words that could not be attributed to any column. Non-empty means low confidence. */
  readonly orphanWords: readonly string[];
  /**
   * Count of text runs discarded as anonymization residue. The text itself is
   * deliberately NOT kept: it is a fragment of a patient name, and this pipeline
   * does not store patient names anywhere, not even in a debug field.
   */
  readonly residueCount: number;
  /** True when the residue could not be told apart from real content. Lowers confidence. */
  readonly ambiguousResidue: boolean;
}

export interface DocumentTotals {
  readonly derechos: string | null;
  readonly honorarios: string | null;
  readonly total: string | null;
}

export interface TableReadResult {
  readonly rows: readonly RawRow[];
  readonly printedTotals: DocumentTotals;
  readonly pagesWithoutHeader: readonly number[];
}

interface ColumnAnchor {
  readonly key: ColumnKey;
  readonly align: 'left' | 'right';
  readonly left: number;
  readonly right: number;
}

interface VisualLine {
  readonly yCenter: number;
  readonly words: Word[];
}

const LINE_TOLERANCE = 4;
/** Matches a text layer's precision. OCR-backed extractors declare a larger one. */
export const DEFAULT_POSITION_TOLERANCE = 2;
const TOTALS_LABEL = 'TOTAL:';
const FOOTER_TOKEN = 'Página';

const center = (word: Word): number => (word.x0 + word.x1) / 2;
const yCenter = (word: Word): number => (word.y0 + word.y1) / 2;

/** Cluster words into visual lines. Same row of the grid = same vertical band. */
export function groupIntoLines(words: readonly Word[]): VisualLine[] {
  const sorted = [...words].sort((a, b) => yCenter(a) - yCenter(b) || a.x0 - b.x0);
  const lines: { yCenter: number; words: Word[] }[] = [];
  for (const word of sorted) {
    const y = yCenter(word);
    const last = lines[lines.length - 1];
    if (last && Math.abs(y - last.yCenter) <= LINE_TOLERANCE) {
      last.words.push(word);
      // Running mean keeps the band centred as the line accumulates words.
      last.yCenter = last.words.reduce((acc, w) => acc + yCenter(w), 0) / last.words.length;
    } else {
      lines.push({ yCenter: y, words: [word] });
    }
  }
  for (const line of lines) line.words.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/**
 * Normalize a header token for comparison.
 *
 * Case, accents and punctuation carry no information about WHICH column a header word
 * names — `Prestación` and `PRESTACION` are the same column — but they are exactly what
 * an OCR engine gets wrong. Measured on this lot: Vision read `Afiliado` as `Afíliado`
 * on one page out of 146. Under exact matching that single character discarded the whole
 * page: 15 rows and 526.452,09 ARS, silently, because a page with no recognizable header
 * is simply skipped.
 *
 * So the comparison strips what cannot distinguish a column and keeps what can. Note
 * this is not fuzzy matching with a tolerance — every one of the 20 tokens must still be
 * present, in order. There is no threshold to tune, and a data line still cannot pass.
 */
function headerKey(token: string): string {
  return token
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]/gu, '')
    .toLowerCase();
}

/**
 * Walk the candidate line consuming the expected header token sequence.
 * Returns null unless every column is found, in order — a partial match means we
 * are looking at something that is not the header and must not be trusted.
 */
export function readColumnAnchors(line: VisualLine): ColumnAnchor[] | null {
  const anchors: ColumnAnchor[] = [];
  let cursor = 0;
  for (const column of COLUMNS) {
    const first = line.words[cursor];
    if (!first) return null;
    for (const token of column.header) {
      const word = line.words[cursor];
      if (!word || headerKey(word.text) !== headerKey(token)) return null;
      cursor++;
    }
    const last = line.words[cursor - 1]!;
    anchors.push({ key: column.key, align: column.align, left: first.x0, right: last.x1 });
  }
  return anchors;
}

function findHeader(lines: VisualLine[]): { index: number; anchors: ColumnAnchor[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const anchors = readColumnAnchors(lines[i]!);
    if (anchors) return { index: i, anchors };
  }
  return null;
}

/**
 * Column assignment.
 *
 * Text columns are left-aligned, so a word belongs to the last column whose left
 * anchor it clears. The three money columns are right-aligned, so their content
 * grows LEFTWARD from the anchor and a left-edge rule would put `264947,00` in
 * the wrong column. For those, the word's right edge is matched to the nearest
 * column right edge, which is exact to within a point.
 */
export function assignColumn(
  word: Word,
  anchors: readonly ColumnAnchor[],
  positionTolerance = DEFAULT_POSITION_TOLERANCE,
): ColumnKey | null {
  const firstRight = anchors.findIndex((a) => a.align === 'right');
  const moneyBoundary = (anchors[firstRight - 1]!.left + anchors[firstRight]!.left) / 2;

  if (center(word) >= moneyBoundary) {
    let best: ColumnAnchor | null = null;
    let bestDistance = Infinity;
    for (const anchor of anchors.slice(firstRight)) {
      const distance = Math.abs(word.x1 - anchor.right);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = anchor;
      }
    }
    return best ? best.key : null;
  }

  let assigned: ColumnKey | null = null;
  for (const anchor of anchors.slice(0, firstRight)) {
    // Slack for the engine's positional error. See TextExtractor.positionTolerance.
    if (word.x0 >= anchor.left - positionTolerance) assigned = anchor.key;
    else break;
  }
  return assigned;
}

/**
 * Two words belong to the same text run when the second starts just AFTER the first
 * ends. Crystal Reports lays a run out with a constant ~1.5pt inter-word gap.
 *
 * The lower bound is the load-bearing one. A negative gap means the two words overlap
 * on the page, and overlapping glyphs are the one thing a text run never does — so an
 * overlap is positive evidence that the words belong to DIFFERENT runs. Allowing even
 * a couple of points of negative slack here lets a name fragment latch onto the code
 * and push the real description out.
 */
const RUN_GAP_MIN = -0.5;
const RUN_GAP_MAX = 8;

export interface RunSeparation {
  readonly kept: Word[];
  readonly residueCount: number;
  readonly ambiguous: boolean;
}

/**
 * Separate the interleaved text runs inside a Prestación cell.
 *
 * The anonymizer blanked the "Apellido y Nombre" column but left fragments of the
 * original names painted at x ~= 527 — exactly where the nomenclator code starts.
 * Sorting the cell's words by x therefore INTERLEAVES two independent runs:
 *
 *   "420101"[527.0-547.9] "GINA"[529.8-545.1] "VANESA"[546.5-571.4]
 *   "CONSULTA"[549.8-582.8] "MEDICA"[584.3-608.6]
 *
 * Read left to right that is `420101 GINA VANESA CONSULTA MEDICA`. A filter that only
 * drops words overlapping the code keeps VANESA and then loses CONSULTA — which is how
 * a patient's first name ends up inside a practice description, in a file we hand to
 * an auditor.
 *
 * So rebuild the runs instead of the reading order. A run is a chain of words separated
 * by one space width; each word joins the open chain whose end it continues most
 * tightly, or opens a new one. Above, that recovers exactly `420101 CONSULTA MEDICA`
 * and `GINA VANESA`. The run carrying the billing code is the cell; every other run is
 * residue, and residue is a patient name — counted, then dropped.
 */
export function separateTextRuns(words: readonly Word[]): RunSeparation {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
  const runs: Word[][] = [];
  const ends: number[] = [];

  for (const word of sorted) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < runs.length; i++) {
      const gap = word.x0 - ends[i]!;
      if (gap >= RUN_GAP_MIN && gap <= RUN_GAP_MAX && gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best === -1) {
      runs.push([word]);
      ends.push(word.x1);
    } else {
      runs[best]!.push(word);
      ends[best] = Math.max(ends[best]!, word.x1);
    }
  }

  const withCode = runs.filter((run) => run.some((w) => BILLING_CODE.test(w.text)));
  if (withCode.length !== 1) {
    // No run owns a code, or two do. Either way we will not pick a winner by guessing.
    return { kept: sorted, residueCount: 0, ambiguous: withCode.length > 1 };
  }

  const cell = withCode[0]!;
  return { kept: cell, residueCount: sorted.length - cell.length, ambiguous: false };
}

/** Every column present and blank. A missing cell is '' — never undefined — downstream. */
export function emptyCells(): Cells {
  return Object.fromEntries(COLUMNS.map((c) => [c.key, ''])) as Cells;
}

function appendCell(cells: Cells, key: ColumnKey, text: string): void {
  cells[key] = cells[key] === '' ? text : `${cells[key]} ${text}`;
}

export interface ReadTableOptions {
  /** The extractor's positional error, in points. See TextExtractor.positionTolerance. */
  readonly positionTolerance?: number;
}

/**
 * Read one document's pages into logical rows.
 *
 * A logical row OPENS on any line that carries a value in the `Nro. Int.` column
 * and stays open until the next one does — absorbing wrapped cells, and crossing
 * page breaks, because the open row is not closed when the page ends.
 */
export function readTable(
  document: string,
  pages: readonly ExtractedPage[],
  options: ReadTableOptions = {},
): TableReadResult {
  const positionTolerance = options.positionTolerance ?? DEFAULT_POSITION_TOLERANCE;
  const rows: RawRow[] = [];
  const pagesWithoutHeader: number[] = [];
  let printedTotals: DocumentTotals = { derechos: null, honorarios: null, total: null };

  let open: {
    page: number;
    pages: Set<number>;
    cells: Cells;
    orphans: string[];
    residueCount: number;
    ambiguousResidue: boolean;
  } | null = null;

  const close = (): void => {
    if (!open) return;
    rows.push({
      source: 'GEOMETRY',
      document,
      page: open.page,
      pages: [...open.pages].sort((a, b) => a - b),
      cells: open.cells,
      orphanWords: open.orphans,
      residueCount: open.residueCount,
      ambiguousResidue: open.ambiguousResidue,
    });
    open = null;
  };

  for (const page of pages) {
    const lines = groupIntoLines(page.words);
    const header = findHeader(lines);
    if (!header) {
      pagesWithoutHeader.push(page.page);
      continue;
    }

    for (const line of lines.slice(header.index + 1)) {
      // The page footer ("Página 1 de 32") sits below the grid and its numbers land in
      // the money columns. Everything from the footer down is not table content.
      if (line.words.some((w) => w.text === FOOTER_TOKEN)) break;

      const byColumn = new Map<ColumnKey, Word[]>();
      const orphans: string[] = [];
      for (const word of line.words) {
        const key = assignColumn(word, header.anchors, positionTolerance);
        if (!key) {
          orphans.push(word.text);
          continue;
        }
        const bucket = byColumn.get(key);
        if (bucket) bucket.push(word);
        else byColumn.set(key, [word]);
      }

      const practice = separateTextRuns(byColumn.get('prestacion') ?? []);
      byColumn.set('prestacion', practice.kept);

      const cells = emptyCells();
      for (const [key, bucket] of byColumn) {
        for (const word of bucket) appendCell(cells, key, word.text);
      }

      // The document's grand total line: no internal number, the literal TOTAL:.
      if (cells.nroInterno === '' && Object.values(cells).some((v) => v.includes(TOTALS_LABEL))) {
        printedTotals = {
          derechos: cells.derechos || null,
          honorarios: cells.honorarios || null,
          total: cells.total || null,
        };
        continue;
      }

      if (cells.nroInterno !== '') {
        close();
        open = {
          page: page.page,
          pages: new Set([page.page]),
          cells,
          orphans,
          residueCount: practice.residueCount,
          ambiguousResidue: practice.ambiguous,
        };
        continue;
      }

      // Continuation line: fold it into the open row.
      if (!open) continue;
      for (const column of COLUMNS) {
        if (cells[column.key] !== '') appendCell(open.cells, column.key, cells[column.key]);
      }
      open.orphans.push(...orphans);
      open.residueCount += practice.residueCount;
      open.ambiguousResidue ||= practice.ambiguous;
      open.pages.add(page.page);
    }
  }

  close();
  return { rows, printedTotals, pagesWithoutHeader };
}
