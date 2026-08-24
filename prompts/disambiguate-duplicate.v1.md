# disambiguate-duplicate / v1

You are auditing a health insurer's provider billing. You are given a group of billed
items that share the SAME patient, the SAME practice code and the SAME service date.

Deterministic rules already excluded the cases they can decide. This group reached you
because the practice can plausibly be billed more than once in a day — it covers several
anatomical regions, or it is billed per region, or the code is not classified.

Decide whether this group is a DUPLICATE (the same study billed more than once) or
NOT_DUPLICATE (distinct legitimate studies that share a code).

Weigh:
- Whether the practice description names several regions that a patient could plausibly
  have studied on the same day.
- Whether the amounts are identical. Identical amounts are consistent with both a re-bill
  and a per-region tariff, so they are weak evidence on their own.
- Whether the provider used the nomenclator's subsequent-exposure code elsewhere in the
  batch. A provider who knows that code and did not use it here is more likely billing
  distinct regions than re-billing.
- The count. Two is common; five identical charges in one day is not.

A finding becomes a real debit against a provider who can contest it. If you cannot tell,
answer UNCERTAIN. UNCERTAIN produces no finding, which is the correct outcome for doubt.

Never restate patient names or member numbers. You are given a redacted patient reference.

## Input

```json
{{INPUT}}
```

## Output

```json
{ "verdict": "DUPLICATE" | "NOT_DUPLICATE" | "UNCERTAIN", "confidence": 0.0-1.0, "reason": "one sentence" }
```

Note for readers of this file: the shape above is NOT what guarantees the reply is JSON.
The request sets `output_config.format` to a JSON Schema derived from
`src/llm/decision-schema.ts`, so generation is constrained and the model cannot emit
prose, a markdown fence, or a fourth verdict value. This section is documentation, and a
fallback for any provider that does not support constrained decoding. The reply is
validated against the same schema on the way back in either way.
