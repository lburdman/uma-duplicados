# ADR 0003 — When in doubt, do not emit

**Status:** accepted · **Date:** 2026-08-24

## Context

Every approved finding is a real debit against a provider who can contest it. The two
error types are not symmetric:

- A **false negative** costs the insurer the amount of one missed duplicate. It is
  recoverable — the next audit, a rule improvement, a later batch.
- A **false positive** costs the amount returned plus the provider's objection, and it
  damages the credibility of every other finding in the same batch. An auditor who
  rejects three of your findings starts checking all of them by hand, and at that point
  the system has negative value.

## Decision

Doubt resolves against emitting, at every layer.

## Consequences

Concretely, in this order:

1. **Unclassified practice codes never auto-emit.** The repeatability table defaults to
   `UNKNOWN`, and `UNKNOWN` is routed to layer 2, never to a finding.
2. **Multi-region practices never auto-emit.** `Rx codo-antebrazo-muñeca-mano-rodilla-
   pierna-pie` is one code for seven regions; two charges in a day may be two regions.
3. **A low-confidence extraction never becomes a debit.** Any item below 0.8 confidence
   takes its whole group out of contention (`R2-LOW-CONFIDENCE-ABSTAIN`), because a
   debit resting on a field we were not sure we read is a debit lost on appeal.
4. **The LLM's `UNCERTAIN` produces nothing.** The prompt says so explicitly, and the
   router treats anything other than a positive `DUPLICATE` as no finding.
5. **A member number we cannot split into CUIL + suffix is unextracted**, not guessed.
   Guessing merges two siblings into one patient or splits one patient into two — the
   first is a false debit, the second a missed duplicate.

The measured price on this lot: of 43 candidate groups, 7 become findings and 22 are
escalated and declined. Some of those 22 may be real duplicates. That is the trade
being made, on purpose, and the `decisions` table records every one of them so a human
can review the calls the machine declined to make — `pnpm review` ranks them by the
amount at stake.
