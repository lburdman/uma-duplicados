import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtractedPage, TextExtractor, Word } from './ports.ts';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(HERE, '../../tools/ocr');
const SOURCE = join(TOOL_DIR, 'vision-ocr.swift');
const BINARY = join(TOOL_DIR, 'vision-ocr');

/** Rasterization density. 300 dpi is the usual floor for reliable OCR of 8pt text. */
const DEFAULT_DPI = 300;

export interface VisionOcrOptions {
  readonly dpi?: number;
  readonly languages?: readonly string[];
}

/**
 * OCR fallback on Apple's Vision framework.
 *
 * Why this and not Tesseract or a cloud OCR: it is already on every Mac, it costs
 * nothing per page, it does not leave the machine — which matters when the pages are
 * patient billing — and its Spanish accuracy on printed text is good. The cost is that
 * it only runs on macOS, so this is a fallback, not the default.
 *
 * It sits behind the same `TextExtractor` port as poppler and returns words in the same
 * coordinate space, so `readTable` reconstructs the grid from OCR output using exactly
 * the same code path. There is no separate "OCR mode" downstream — that is the entire
 * point of the port existing.
 *
 * Honest limitation: OCR output is not bit-reproducible across OS versions the way a
 * text layer is. A lot extracted this way keeps the idempotency guarantee within one
 * machine and one OS version, and loses it across an OS upgrade. The extractor id and
 * version recorded on every document are what makes that visible instead of silent.
 */
export class VisionOcrExtractor implements TextExtractor {
  readonly id = 'apple-vision:ocr';
  readonly version: string;
  /**
   * Measured on this lot at 300 dpi: box edges land up to ~2.5pt off the anchor. 6 gives
   * margin without approaching the 19pt ceiling set by the widest overflowing cell.
   */
  readonly positionTolerance = 6;
  readonly #dpi: number;
  readonly #languages: string;

  constructor(version: string, options: VisionOcrOptions = {}) {
    this.version = version;
    this.#dpi = options.dpi ?? DEFAULT_DPI;
    this.#languages = (options.languages ?? ['es-ES', 'en-US']).join(',');
  }

  /**
   * Build the Swift helper if it is not already there, and report the OS version it was
   * built against — Vision's model ships with the OS, so that string is part of the
   * extractor's identity and lands in every document's trace.
   */
  static async detect(options: VisionOcrOptions = {}): Promise<VisionOcrExtractor> {
    if (process.platform !== 'darwin') {
      throw new Error('Apple Vision OCR is only available on macOS.');
    }
    try {
      await access(BINARY);
    } catch {
      try {
        await run('swiftc', ['-O', '-o', BINARY, SOURCE, '-framework', 'Vision', '-framework', 'CoreGraphics', '-framework', 'ImageIO']);
      } catch (error) {
        throw new Error(`could not build the Vision OCR helper: ${String(error)}`);
      }
    }
    const { stdout } = await run('sw_vers', ['-productVersion']);
    return new VisionOcrExtractor(`macos-${stdout.trim()}`, options);
  }

  async extract(pdfPath: string): Promise<ExtractedPage[]> {
    const sizes = await pageSizes(pdfPath);
    const workDir = await mkdtemp(join(tmpdir(), 'uma-ocr-'));
    try {
      await run('pdftoppm', ['-r', String(this.#dpi), '-png', pdfPath, join(workDir, 'page')], {
        maxBuffer: 64 * 1024 * 1024,
      });
      // pdftoppm zero-pads the index by page count, so sort the names rather than guess.
      const images = (await readdir(workDir)).filter((f) => f.endsWith('.png')).sort();

      const pages: ExtractedPage[] = [];
      for (const [index, image] of images.entries()) {
        const size = sizes[index] ?? sizes[sizes.length - 1]!;
        pages.push({
          page: index + 1,
          width: size.width,
          height: size.height,
          words: await this.#recognize(join(workDir, image), size),
        });
      }
      return pages;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async #recognize(imagePath: string, size: PageSize): Promise<Word[]> {
    const { stdout } = await run(
      BINARY,
      [imagePath, String(size.width), String(size.height), this.#languages],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { words: (Word & { confidence: number })[] };
    return parsed.words.map(({ text, x0, y0, x1, y1 }) => ({ text, x0, y0, x1, y1 }));
  }
}

interface PageSize {
  readonly width: number;
  readonly height: number;
}

/** Page geometry in points, so OCR boxes land in the same space poppler reports. */
export async function pageSizes(pdfPath: string): Promise<PageSize[]> {
  const { stdout } = await run('pdfinfo', ['-f', '1', '-l', '-1', pdfPath], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const sizes: PageSize[] = [];
  for (const match of stdout.matchAll(/Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)/g)) {
    sizes.push({ width: Number(match[1]), height: Number(match[2]) });
  }
  if (sizes.length === 0) {
    // Single-page PDFs report "Page size:" with no index.
    const single = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(stdout);
    if (single) sizes.push({ width: Number(single[1]), height: Number(single[2]) });
  }
  return sizes;
}
