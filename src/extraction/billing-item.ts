import { z } from 'zod';

/**
 * The canonical shape of one billed item, after normalization.
 * Everything downstream — blocking, rules, findings, evals — speaks only this.
 */
export const BillingItemSchema = z.object({
  /** Deterministic identity: document content hash + internal number. Stable across runs. */
  itemId: z.string(),
  documentId: z.string(),
  /** File name as delivered. This is what the auditor opens. */
  document: z.string(),
  /** Page the row starts on. This is where the auditor looks. */
  page: z.number().int().positive(),
  /** Every page the row spans, when it wraps across a page break. */
  pages: z.array(z.number().int().positive()).nonempty(),
  nroInterno: z.string(),

  /** CUIL + family suffix. The patient identity used everywhere. */
  patientKey: z.string(),
  cuil: z.string(),
  suffix: z.string(),

  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** PRACTICE or MEDICATION. Decides whether the item is eligible for duplicate rules. */
  kind: z.enum(['PRACTICE', 'MEDICATION']),
  practiceCode: z.string(),
  practiceDescription: z.string(),
  professional: z.string(),
  service: z.string(),
  quantity: z.number().int(),

  derechosCents: z.number().int(),
  honorariosCents: z.number().int(),
  totalCents: z.number().int(),

  /** 1.0 = every field parsed cleanly. Anything below 1 carries a reason in warnings. */
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
});

export type BillingItem = z.infer<typeof BillingItemSchema>;

export const UNEXTRACTED_REASONS = [
  'MISSING_MEMBER_ID',
  'MALFORMED_MEMBER_ID',
  'MISSING_SERVICE_DATE',
  'MALFORMED_SERVICE_DATE',
  'MISSING_PRACTICE_CODE',
  'MALFORMED_AMOUNT',
  'MALFORMED_QUANTITY',
  'AMBIGUOUS_OVERLAPPING_TEXT',
  'MALFORMED_ROW',
] as const;

export type UnextractedReason = (typeof UNEXTRACTED_REASONS)[number];

export const UnextractedItemSchema = z.object({
  documentId: z.string(),
  document: z.string(),
  page: z.number().int().positive(),
  nroInterno: z.string().nullable(),
  reason: z.enum(UNEXTRACTED_REASONS),
  /** Human-readable context. Never contains a name or a member number. */
  detail: z.string(),
  /**
   * The amount printed on the row, when it was readable. Reported so the README can
   * state how much money we failed to normalize, not just how many rows.
   */
  totalCents: z.number().int().nullable(),
});

export type UnextractedItem = z.infer<typeof UnextractedItemSchema>;
