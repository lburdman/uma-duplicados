import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtractedPage, TextExtractor, Word } from './ports.ts';

const run = promisify(execFile);

/**
 * poppler's `pdftotext -bbox-layout` gives one <word> element per token with its
 * bounding box in PDF points.
 *
 * Why word coordinates instead of `-layout` plain text: this is a Crystal Reports
 * fixed grid. Plain text extraction flattens the grid into a flow and you then
 * try to recover columns by counting spaces — which breaks the moment two runs of
 * text share an x position, or a cell wraps. Coordinates keep the table a table.
 *
 * Trade-off: poppler is a local binary. No per-page cost, no network latency,
 * fully deterministic — the same PDF yields byte-identical words every run, which
 * is a precondition for the idempotency guarantee. The price is that it only works
 * on PDFs that carry a text layer.
 */
export class PopplerTextExtractor implements TextExtractor {
  readonly id = 'poppler:pdftotext-bbox-layout';
  readonly version: string;
  /** A text layer reports exact render coordinates; the observed error is under a point. */
  readonly positionTolerance = 2;

  constructor(version = 'unknown') {
    this.version = version;
  }

  static async detect(): Promise<PopplerTextExtractor> {
    try {
      const { stderr, stdout } = await run('pdftotext', ['-v']);
      const match = /pdftotext version ([\d.]+)/.exec(`${stderr}${stdout}`);
      return new PopplerTextExtractor(match?.[1] ?? 'unknown');
    } catch {
      throw new Error('pdftotext (poppler) not found on PATH. Install with: brew install poppler');
    }
  }

  async extract(pdfPath: string): Promise<ExtractedPage[]> {
    const { stdout } = await run('pdftotext', ['-bbox-layout', pdfPath, '-'], {
      maxBuffer: 512 * 1024 * 1024,
    });
    return parseBboxLayout(stdout);
  }
}

const PAGE_OPEN = /<page width="([\d.]+)" height="([\d.]+)">/g;
const WORD = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;

/** Minimal targeted parse. A general XML parser buys nothing here and costs a dependency. */
export function parseBboxLayout(xml: string): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const bounds: { start: number; width: number; height: number }[] = [];

  PAGE_OPEN.lastIndex = 0;
  for (let m = PAGE_OPEN.exec(xml); m !== null; m = PAGE_OPEN.exec(xml)) {
    bounds.push({ start: m.index + m[0].length, width: Number(m[1]), height: Number(m[2]) });
  }

  bounds.forEach((page, index) => {
    const end = index + 1 < bounds.length ? bounds[index + 1]!.start : xml.length;
    const slice = xml.slice(page.start, end);
    const words: Word[] = [];
    WORD.lastIndex = 0;
    for (let m = WORD.exec(slice); m !== null; m = WORD.exec(slice)) {
      const text = decodeEntities(m[5]!);
      if (text.trim() === '') continue;
      words.push({
        text,
        x0: Number(m[1]),
        y0: Number(m[2]),
        x1: Number(m[3]),
        y1: Number(m[4]),
      });
    }
    pages.push({ page: index + 1, width: page.width, height: page.height, words });
  });

  return pages;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}
