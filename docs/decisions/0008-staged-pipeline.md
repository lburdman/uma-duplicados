# ADR 0008 — Three stages with the database as the boundary

**Status:** accepted · **Date:** 2026-08-24

## Context

The cheap way to write this pipeline is one function: PDFs → items in memory → findings
in memory → persist everything → project to JSON. It produces the right answer, and its
output can be made deterministic and idempotent.

What it cannot do is any of this:

- **Re-run detection without re-reading the PDFs.** A rule change is the common case, not
  the rare one, and it should not cost 146 pages of extraction to see its effect.
- **Notice a serialization defect.** Anything lost or mangled on the way into SQLite is
  invisible to a detector that reads the in-memory array, and surfaces — if at all — in a
  report nobody diffs.
- **Treat storage as a contract.** Persisting last makes the database a place results are
  copied to, rather than the interface between two halves of the work.

## Decision

Three stages, one direction, SQLite as the boundary between each pair.

```
1. extract   PDFs        →  documents, items, unextracted_items
2. detect    items (SQL) →  findings, finding_items, finding_traces, decisions
3. report    SQL         →  items.json, hallazgos.json
```

Each is separately runnable: `pnpm extract ./lote`, `pnpm detect`, `pnpm report`.
`pnpm start ./lote` is the three in order over one open database.

Stage 2 takes no lot directory and no extractor. It cannot open a PDF even if it wanted
to. The extractor that produced the rows is read back from the `documents` table, so
even the trace's provenance comes from stored data rather than from what the caller
happened to pass in.

## Consequences

The round trip through SQL costs one query per run and buys three things:

1. **Detection is reproducible from stored data.** Change a rule, run `pnpm detect`, and
   you are adjudicating exactly the bytes an auditor would see — no PDF involved.
2. **Serialization defects surface in the detector**, not in a report diff. If a field
   does not survive the round trip, blocking or a rule breaks immediately.
3. **Each stage is separately idempotent**, so a failure in one does not force redoing
   the others.

Lot-level description canonicalization (ADR 0002) belongs to stage 1: it is about
reading the page correctly and it needs every document to vote, so it runs before the
items are persisted rather than between the stages.

Verified by test: `detectOnly()` is called with no lot directory and no extractor and
produces the same finding ids as the full run, retracting nothing.
