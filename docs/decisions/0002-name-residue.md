# ADR 0002 — Separate anonymization residue by rebuilding text runs

**Status:** accepted · **Date:** 2026-08-24

## Context

The anonymizer blanked the "Apellido y Nombre" column but left fragments of the
original names on the page — `ROS`, `ABRIEL`, `RACIELA`, `GINA VANESA`, `DEL CARMEN` —
painted at x ≈ 527, which is where the Prestación cell begins. 262 of the 2.169 rows are
affected.

Sorted by x, the cell reads as one sequence:

```
"420101"[527.0-547.9] "GINA"[529.8-545.1] "VANESA"[546.5-571.4]
"CONSULTA"[549.8-582.8] "MEDICA"[584.3-608.6]
```

which is `420101 GINA VANESA CONSULTA MEDICA`. Two failure modes follow. The mild one
is a patient's first name in a practice description in a file we hand to an auditor.
The severe one is `R 430201` or `250101 ROS`, where the fragment changes the parsed
identity of the practice and therefore what gets compared to what.

## Decision

Rebuild the text runs instead of trusting the reading order. A run is a chain of words
each starting ~1.5pt after the previous one ends; each word joins the open chain it
continues most tightly, or opens a new one. The run carrying the billing code is the
cell. Every other run is residue: counted, then dropped.

## Consequences

The load-bearing detail is the lower bound on the gap, which is −0.5pt. A negative gap
means the words overlap on the page, and overlapping glyphs are the one thing a text run
never does — so an overlap is positive evidence of a run boundary, and the bound exists
only to absorb rounding. Widen it to a couple of points and `VANESA` latches onto the
code, which pushes `CONSULTA` out of the cell: the fragment is kept and the real
description is lost.

This is deliberately scoped per cell rather than applied to the page. A long
`CONSULTORIOS EXT PEDIATRICOS` legitimately overflows into the Fecha column; those
words still belong to their own cells and are left alone.

Residue text is never stored — not in the item, not in a debug field, not in a log.
Only a count survives, which lowers the item's confidence.

**Defense in depth.** Geometry alone still left one row labelled `VALLE`. So a lot-wide
pass replaces a description when the row had residue removed AND the description is a
fringe variant for its code (seen ≤3 times against a majority ≥5× larger). Code 420101
legitimately reads `CONSULTA MEDICA` 328 times and `CONSULTA GINECOLOGICA` 38 times;
the second is real report text and survives. Substituted descriptions carry the warning
`DESCRIPTION_RECOVERED_FROM_CODE` — a value we inferred is not a value we read.
