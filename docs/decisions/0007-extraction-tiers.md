# ADR 0007 — Three extraction tiers, chained per page

**Status:** accepted · **Date:** 2026-08-24

## Context

Every page in this lot carries an embedded text layer, so the geometric reader answers
all 146 of them. The question this ADR settles is what happens to the page that does
not: a scanned insert bound into a digital batch, or a whole document delivered as
images.

A fallback nobody has ever watched execute is the same as a fallback that does not work,
so each tier here is implemented and runnable on demand, not described as future work.

## Decision

Three tiers, chained per page, cheapest and most trustworthy first.

| | Tier | API cost | Speed | Coordinates | Can hallucinate |
|---|---|---|---|---|---|
| 1 | text layer (poppler) | — | 5,0 ms/page | measured | no |
| 2 | local OCR (Apple Vision) | — | 2,6 s/page | inferred | no |
| 3 | multimodal model | per page | ~1 s/page | none | **yes** |

The ordering is the cost argument and the trust argument at once, and they happen to
agree: the only tier that bills per page is also the only one whose output is *written*
rather than *measured*, so it is the last one asked.

Three properties hold the chain together:

- **Per page, not per document.** The realistic failure is one bad page in 146. A
  document-level switch either reprocesses 145 good pages to rescue one, or skips the one
  and loses it along with its money.
- **The trigger is "this page produced no rows".** Not a word-count threshold, which is
  only ever a proxy for it — and a misleading one, because a scan with a stamped digital
  header *has* text. No rows is the thing actually worth acting on, and it is what the
  next tier is asked to fix.
- **Lazy and non-fatal.** A tier is not built until a page needs it, and a build failure
  (not a Mac, no API key) degrades to one log line. A batch of 146 pages must not fail
  because a fallback was unavailable.

## The port is agnostic to the method, not to the shape

`TextExtractor` promises **words with coordinates**. Poppler reports where the renderer
put each glyph; Vision infers a box per token from pixels. Different methods, same
contract — which is why a page can be swapped between tiers 1 and 2 freely and the
geometric table reconstruction runs unchanged on either.

A multimodal model does not report where the ink is. It reports what the table says. You
can ask it for bounding boxes and it will produce plausible numbers with real error, and
then the geometric reconstruction — column anchors, right-edge matching, text-run
separation, all of it tuned to sub-point precision — runs on coordinates nobody measured.
That is not reuse; it is a category error wearing the costume of reuse.

So the abstraction that is genuinely agnostic sits one level up:

```ts
interface DocumentReader {
  read(document, pdfPath): Promise<ReadResult>   // rows, not words
}
```

`GeometricDocumentReader` wraps any `TextExtractor` and runs `readTable`.
`LlmDocumentReader` calls a model and maps its answer straight to rows. They share no
shape below this line, and that is the honest description of the situation. It is also
why the fallback is one mechanism and not two: the chain substitutes whole pages at the
row level, which is the only granularity all three tiers can agree on.

## Tier 2 — Apple Vision

Why Vision and not Tesseract or a cloud OCR: it is already on every Mac, costs nothing
per page, and never leaves the machine — which matters when the pages are patient
billing. The price is that it is macOS-only, which is acceptable for a fallback and would
not be for the default.

- **Word-level boxes, not lines.** `VNRecognizedText.boundingBox(for:)` is asked for a box
  per whitespace-delimited token. The whole table reconstruction works on word geometry,
  so returning lines would have needed a second, different table reader.
- **Coordinates converted at the boundary.** Vision reports normalized boxes with a
  bottom-left origin; poppler reports points with a top-left origin. The Swift helper
  converts, so the two engines are genuinely interchangeable.
- **Language correction off.** The grid holds nomenclator codes, dates and amounts.
  Correction "fixes" `340213` into something more word-like, which is the opposite of
  what an audit trail needs.

**Positional precision is a property of the engine.** A text layer reports the exact
coordinates the renderer used; its error is under a point. OCR infers boxes from pixels
and wobbles. Measured on page 1 of this lot: the practice code sits 1.0pt left of its
column anchor via the text layer and 2.4pt left via Vision. A tolerance calibrated for
one silently misfiles columns for the other — at 2pt, Vision files every nomenclator code
into the patient-name column, and the rows then read perfectly and get discarded for
having no practice code. So `positionTolerance` lives on the `TextExtractor` interface:
2 for poppler, 6 for Vision. The ceiling is 19pt, set by the widest legitimately
overflowing cell in the lot (`CONSULTORIOS EXT PEDIATRICOS` reaching toward the Fecha
anchor).

**Measured on page 1** (`pnpm ocr lote/detalle_ANONIMIZADO.pdf 1`):

| | text layer | Vision OCR |
|---|---|---|
| words | 254 | 252 |
| rows reconstructed | 15 | 15 |
| items parsed | 15 | 15 |
| sum of the Total column | 449.958,27 | 449.958,27 |
| time per document (32 pages) | 180 ms | 82.285 ms |

100 % agreement on member number, service date and amount across all 15 rows. OCR is
**~450× slower**, which is the whole argument for keeping it as a fallback.

## What running the whole lot through OCR found

Exercising the fallback page by page proves it works and proves nothing about whether the
pipeline *survives* it. So the entire lot is re-extractable with `EXTRACTOR=ocr` — a
validation mode that forces OCR on every page, text layer or not — and the result
compared row by row against the text layer. Two defects surface that no unit test would
have found.

### One accent costs a page and 526.452,09 ARS

Vision reads `Afiliado` as `Afíliado` in the header of page 8 of `detalle_ANONIMIZADO`.
One character, on one page out of 146. Under exact matching on all twenty header tokens
the header is not recognized, so the page is skipped, so its fifteen rows never exist —
and the document stops reconciling, which is the only reason it is noticeable at all.

The answer is not a similarity threshold. Case, accents and punctuation cannot
distinguish one column from another — `Prestación` and `PRESTACION` name the same column
— so they are normalized away before comparison, while every one of the twenty tokens
must still be present, in order. There is no number to tune and a data line still cannot
pass.

That is a text-layer exposure too, incidentally: any document whose header is typed with
a different accent would hit it. OCR only makes it happen.

### The result

Every page of the lot, extracted twice — once from the text layer, once through Vision —
and compared row by row:

| | text layer | Vision OCR |
|---|---|---|
| rows read | 2.169 | **2.169** |
| documents reconciling to the printed total | 3 of 3 | **3 of 3, delta 0,00** |
| items normalized | 2.150 | 1.994 |
| items declared unextracted | 19 | 175 |
| findings | 7 | **the same 7 ids** |
| evidence items backing those findings | 14 | **14 of 14 present** |

Of the 1.994 items both produce: **patient key, service date and amount agree on every
single one**. The only field that diverges is the practice code, on 20 items — 16 of them
the gridline artifact below, 4 genuine glyph confusions (`861212` → `361212`).

The shape of the difference is the point. OCR does not produce *wrong* data; it produces
*less* data. 156 rows fail normalization — member number 78, service date 69, practice
code 25, amount 3 — and every one of them lands in `unextracted` with a reason, which is
exactly the machinery ADR 0003 builds for the case where reading is uncertain. The money
still reconciles because reconciliation is computed over rows read, not items normalized.

### The table's own gridlines are read as digits

Twenty items come out with a spurious leading digit: `920101` → `1920101`, `430301` →
`7430301`, `342001` → `1342001`. Always a `1` or a `7` — the two digits shaped like a
vertical stroke.

The bounding boxes say what happened. The text layer reports `920101` spanning
527.0–547.9; Vision reports `1920101` spanning **523.8**–547.4. Same right edge, 3.2pt of
extra ink on the left, in a region where the text layer has no glyph at all. That ink is
the column separator rule, and at 300 dpi Vision reads it as a digit and merges it into
the number beside it.

Nothing is done about this, deliberately. The real digits are all present and the code
could be "repaired" by stripping a leading character when the remainder is a code known
elsewhere in the lot — but that is inference dressed as extraction, and ADR 0003 says
this pipeline does not do that. The affected items keep the code that was read, which
means they block into their own group and quietly fail to match anything. A missed
duplicate, not a false debit. That is the trade this project keeps making.

## Tier 3 — the tier that can lie

Everything else in this pipeline reconstructs; this one generates. A model asked to read
a billing grid can return a charge that is not on the page, and unlike a mis-OCRed digit
that failure is silent and well-formed.

So rows from tier 3 are tagged `GENERATIVE`, and `parseRow` applies a 0.25 confidence
penalty for that source alone. The number is not a feeling about model quality: it is set
so a generative row lands at 0.75, **below the 0.8 floor detection requires**. The
consequence is exact — the third tier can rescue a page for the record, for
reconciliation and for a human to read, and cannot produce a debit by itself. A
hallucinated charge costs an audit line, never money. Raising that floor is a person's
decision and it is one line.

Two tests hold this down: a generative row parses but sits under the floor, and a group
built from generative rows is refused by `R2-LOW-CONFIDENCE-ABSTAIN` — with a geometric
control proving the same two rows *would* have been a duplicate.

The image is rendered at 150 dpi, not the 300 the OCR tier uses. A vision model resamples
to its own grid anyway, and an image is billed at roughly width×height/750 tokens, so the
extra pixels buy nothing and quadruple the price of the one tier that bills per page.

## Batch API

`PageExtractionProvider.extractPages` takes the whole page set, not one page. That plural
is the entire reason the Batch API is reachable without a rewrite: batches need every
request up front, and a per-page interface would have had to be redesigned to adopt one.

Extraction is the one stage in this pipeline where the batch trade is obviously right:

- **50 % cheaper**, on the only stage whose volume scales with page count.
- **Nothing downstream is waiting.** A rendición batch is processed on a daily cycle, so
  "within the hour" and "within seconds" are the same answer to the only person asking.
- **The failure mode fits.** Results come back in any order and a request can fail
  individually — so they are keyed by `custom_id`, never by position, and a page whose
  request failed simply produces no rows. The chain sees an empty page and the
  reconciliation gate sees the missing money. Neither is papered over.

Detection is the opposite case and stays synchronous: 22 calls, cents, and a human
waiting on the answer. Half of nothing is nothing.

At a million pages a day the arithmetic decides it, and the arithmetic has to be measured
rather than guessed, because a cost model gets quoted. Measured on page 1 of this lot at
150 dpi: 2.316 image tokens (1568×1108 after Anthropic's long-edge resize, ÷750) plus 439
prompt tokens in, and 1.037 tokens out for a full 15-row page. On `claude-sonnet-5` that
is USD 0,0159 per page synchronous and USD 0,0079 batched — **USD 15.880 versus USD 7.940
per million pages**, *if every page needed tier 3*. Which is the real point: the chain
exists so that number multiplies the small subset of pages with no text layer, not the
whole lot. On this lot it multiplies zero.

## Honest limitations

**OCR is not bit-reproducible across OS versions** the way a text layer is: Vision's model
ships with macOS. A lot extracted this way keeps its idempotency guarantee within one
machine and one OS version and loses it across an upgrade. That is why the extractor id
and version are recorded on every document — so the change is visible rather than silent
— and why `OCR_FALLBACK=off` exists for runs that must be strictly reproducible across
machines.

**Tier 3 is not proven against a real model on this lot.** The default provider is a mock,
and it is deliberately incapable of returning a row: it reports every page as unreadable.
A mock that produced plausible charges would make the demo look like extraction
succeeded, which is the exact reflex this ADR is trying to prevent. What it does exercise
is the request shape, the schema, the token and cost accounting, the batch pricing, and
the chain's decision to fall through. `LLM_OCR=anthropic` swaps in the real client, whose
wire behaviour is covered by `tests/anthropic-wire.test.ts`.

## How to see it run

```bash
pnpm ocr lote/detalle_ANONIMIZADO.pdf 1                       # tier 1 vs tier 2, same page
pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1              # tier 1 empty → tier 2 rescues it
pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1 --no-vision  # tiers 1 and 2 out → tier 3
```

`pnpm ocr:fallback` rasterizes a real page and wraps it back into a PDF, which strips the
text layer while keeping the content identical. Poppler reads 0 words from it, Vision
rescues the page, and the reconstructed rows sum to 449.958,27 — the same figure, to the
cent.

Environment switches: `OCR_FALLBACK=off` disarms tier 2, `LLM_OCR=off` disarms tier 3,
`LLM_OCR=anthropic` swaps the mock for the real client, `OCR_LLM_MODE=batch` switches the
path, and `EXTRACTOR=ocr|llm` forces one tier for the whole lot (validation modes, not
production).
