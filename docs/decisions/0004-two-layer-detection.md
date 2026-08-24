# ADR 0004 — Rules first, model only for the grey zone

**Status:** accepted · **Date:** 2026-08-24

## Context

The brief requires that obvious duplicates be resolved without an LLM and that the LLM
be reserved for ambiguous cases. That is a cost requirement on its face, but it is also
a correctness requirement: a deterministic layer is reproducible and auditable, and a
model is neither.

The hard part is deciding what "ambiguous" means. It is not a confidence threshold on a
similarity score. In this domain it is a specific, nameable question: **can this
practice legitimately be billed more than once for the same patient on the same day?**

## Decision

Two layers, with a versioned repeatability policy deciding which one answers.

**Layer 1** blocks by (patient, canonical practice, service date) and applies five
ordered rules, each with an id and a version:

| Rule | Verdict | Grounded in |
|---|---|---|
| `R1-MEDICATION-OUT-OF-SCOPE` | not duplicate | medications are not "prácticas"; and 3 of the 4 repeated medication groups carry different amounts, which is quantity |
| `R2-LOW-CONFIDENCE-ABSTAIN` | not duplicate | ADR 0003 |
| `R3-DIFFERENT-PRACTICE-TEXT` | not duplicate | the code is a container; a differing printed description means a different service |
| `R4-SUBSEQUENT-EXPOSURE` | not duplicate | 46 of 46 occurrences of 340202/340210/340212/340302 sit next to their first-exposure code on the same day. Zero exceptions |
| `R5-SINGLE-PER-DAY` | **duplicate** | the practice is anatomically singular or encounter-level |
| `R6-NEEDS-JUDGEMENT` | ambiguous | multi-region or unclassified |

`R3` is the one rule that was not derived from aggregate statistics. It came from opening
page 32 of `detalle_(1)` and reading the row: one patient carries `420101` twice on the
same day in the same guardia at the same price, once as `CONSULTA MEDICA` and once as
`CONSULTA GINECOLOGICA`. `420101` is simply "consulta" — the code is a container and the
printed description is what distinguishes the specialty. It is the only such group in the
lot, and without the rule the pipeline debited it.

Because descriptions are truncated at ~30 characters by the report, this rule can only
ever cause a missed duplicate, never an invented one. That is the direction ADR 0003
accepts.

**Layer 2** is the model, and it only ever sees what `R6` (or `R4` without its base
code) explicitly handed over. It receives a redacted projection — patient reference,
practice, amounts, count, and the policy note explaining why layer 1 could not decide.
No name, no CUIL, no member number: the model is a third party and the same PII rules
apply to it as to a log file.

## Consequences

On this lot: 31 of 73 candidate pairs settled deterministically, 42 escalated, 22 model
calls. Blocking removed 2.310.102 pairs that brute force would have compared.

The counter-intuitive result is that **layer 2 emits nothing on this lot**. That is not
layer 2 being decorative — it is layer 2 doing its job. Those 22 groups are exactly the
ones a naive same-key detector would have debited, and every one of them has a benign
explanation the rules could see but not confirm. Layer 2's contribution here is measured
in false positives prevented, not findings produced.

The default provider is a deterministic mock, so `pnpm start` runs with no API key and
the idempotency test has a stable layer 2. `LLM_PROVIDER=anthropic` switches to the real
one; the finding's trace records which answered, with which prompt version and model.
