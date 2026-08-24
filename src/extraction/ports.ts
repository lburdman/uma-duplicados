/**
 * Words with coordinates: the input the geometric table reconstruction runs on.
 *
 * Two engines satisfy this contract — poppler reports where the renderer put each glyph,
 * Apple Vision infers a box per token from pixels — and `readTable` cannot tell them
 * apart. That is the point of the port: swapping the engine for a page changes nothing
 * downstream. A multimodal model does NOT belong here; it reports what the table says
 * rather than where the ink is, so it sits behind `DocumentReader` instead. See ADR 0007.
 */
export interface Word {
  readonly text: string;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface ExtractedPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly words: readonly Word[];
}

export interface TextExtractor {
  /** Goes into the finding trace: an auditor must know which engine produced the bytes. */
  readonly id: string;
  readonly version: string;
  /**
   * How far a word's left edge may sit to the LEFT of a column anchor and still belong
   * to that column, in PDF points.
   *
   * This is a property of the engine, not a tuning knob. A text layer reports the exact
   * coordinates the renderer used, so its error is under a point. OCR infers a box from
   * pixels and its edges wobble by a few points at 300 dpi — measured on this lot, the
   * practice code sits 1.0pt left of its anchor via the text layer and 2.4pt left via
   * Vision. A single tolerance calibrated for one of them silently misfiles columns for
   * the other, which is how a nomenclator code ends up in the patient-name column.
   *
   * The ceiling is set by the tightest real overflow in the document: `CONSULTORIOS EXT
   * PEDIATRICOS` reaches within 19pt of the Fecha anchor, so anything at or above that
   * would start stealing words from the column to its left.
   */
  readonly positionTolerance: number;
  extract(pdfPath: string): Promise<ExtractedPage[]>;
}
