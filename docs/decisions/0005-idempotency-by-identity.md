# ADR 0005 — Idempotency by content-derived identity

**Status:** accepted · **Date:** 2026-08-24

## Context

"Running twice must not create duplicate findings or change the result." The usual
implementations are a run-level "have I seen this batch?" check, or truncate-and-reload.
Both work until the lot is partially re-delivered, or two runs overlap, or a document
arrives under a different name.

## Decision

Nothing generates an identity. Every primary key is derived from content:

| Entity | Key |
|---|---|
| document | `sha256(file bytes)[0:16]` |
| item | `documentId:nroInterno` |
| finding | `sha256(tipo \| patientKey \| canonicalCode \| serviceDate \| sorted itemIds)[0:24]` |
| unextracted row | `sha256(documentId \| page \| nroInterno \| reason \| detail)[0:24]` |

Every write is `INSERT ... ON CONFLICT DO UPDATE`. There is no idempotency check in the
application code, because the database cannot represent the duplicate.

## Consequences

Content-derived keys are necessary and not sufficient. Three things break the guarantee
quietly, so the pipeline forbids all three:

1. **No wall-clock timestamp anywhere in the output.** `decidedAt` is an input to the
   run, not a side effect of it. A `new Date()` in the trace puts a different string in
   every row and the output differs between runs over a field nobody reads.
2. **Deterministic ordering everywhere.** PDFs are processed in sorted filename order;
   items within a group are sorted by (documentId, nroInterno); findings are sorted by
   id; every projection query carries an explicit `ORDER BY`. Without them SQLite is
   free to return rows in any order and idempotency becomes a coin flip.
3. **The JSON is projected from SQLite, not from memory.** Writing the files from the
   objects the run just built would only prove the pipeline is deterministic. Reading
   back through SQL means byte-identical output is evidence that the upserts landed on
   the same rows — which is the property actually being claimed.

Because the document id is the file's content hash, renaming a PDF changes nothing, and
delivering the same PDF twice under two names is recognised as one document.

**Retraction.** Upserting prevents duplicates but does not remove a finding that a rule
change has withdrawn — it would sit in the table forever and an auditor would eventually
approve a debit the current rules no longer support. So each run deletes findings it did
not reproduce, and reports the count.

Verified by `tests/pipeline.test.ts`: two consecutive runs over the real lot produce
byte-identical `items.json` and `hallazgos.json`, and not one extra row in any of the
seven data tables.
