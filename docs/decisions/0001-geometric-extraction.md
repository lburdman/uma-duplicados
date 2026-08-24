# ADR 0001 — Extract by word geometry, not by text flow

**Status:** accepted · **Date:** 2026-08-24

## Context

The lot is 146 pages of Crystal Reports output with a fixed twelve-column grid. Three
extraction strategies were on the table: a multimodal LLM per page, OCR, and a local
PDF text layer.

Every page in the lot carries an embedded text layer, so OCR would be re-deriving
information the file already states. An LLM per page costs money and latency per page
and, more importantly, is not bit-reproducible — and this pipeline has to promise that
two runs produce identical output. Both are worth having for the page that has no text
layer, which makes them fallbacks rather than the default; ADR 0007 covers how they are
chained. This ADR is about the default.

That leaves the text layer, and a second choice inside it: `pdftotext -layout`, which
flattens the grid into aligned text, or `pdftotext -bbox-layout`, which gives one
bounding box per word.

## Decision

Word coordinates, and rebuild the table geometrically.

## Consequences

Flowed text loses the column semantics and you spend the rest of the project trying to
recover them by counting spaces. Three things in this lot break that approach outright:

1. **Rows wrap.** A cell too wide for its column continues on the next visual line, and
   rows continue across page breaks. A row-per-line regex reads 1.731 of the 2.169
   rows and silently drops the rest.
2. **Money columns are right-aligned.** `264947,00` starts to the left of the `Hon.`
   column's left edge. A left-edge rule files it in the wrong column and the document
   stops reconciling.
3. **The anonymizer left name fragments painted at x ≈ 527**, exactly where the
   nomenclator code starts. In flowed text they are indistinguishable from content;
   in coordinates they are a second text run that overlaps the first, which is
   something a layout engine never does within a cell. See ADR 0002.

The cost is a dependency on the poppler binary and roughly 150 lines of geometry. The
benefit is measurable: 2.169 of 2.169 rows read, and all three documents reconcile to
the cent against the `TOTAL:` the provider printed on them.

The reconstruction is calibrated to sub-point precision, so the tolerance it allows
around a column anchor is a property of whichever engine produced the words, not a
constant of the table reader. `TextExtractor.positionTolerance` carries it: 2pt for a
text layer, which reports the coordinates the renderer used, and more for an engine that
infers boxes from pixels. A single tolerance shared by both silently misfiles columns
for one of them.

## What is not here

**No second extractor as a cross-check.** The obvious safety net for a geometric reader
is a second implementation that must agree with it. The reconciliation gate is a better
one: it checks against a number the provider signed, not against another implementation
of my own assumptions. A second extractor agreeing with the first proves less than a
document adding up. `pnpm ocr` puts two genuinely independent engines on the same page
when a second opinion is wanted.

**No correction of what was read.** A code that comes out of the geometry malformed stays
malformed and its row is declared unextracted. Repairing it would be inference dressed as
extraction, which is the one thing this pipeline does not do.
