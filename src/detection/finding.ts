import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BillingItem } from '../extraction/billing-item.ts';
import type { CandidateGroup } from './blocking.ts';

export const FINDING_TYPES = ['PRACTICA_DUPLICADA'] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const EvidenceSchema = z.object({
  itemId: z.string(),
  document: z.string(),
  page: z.number().int().positive(),
  nroInterno: z.string(),
  serviceDate: z.string(),
  practiceCode: z.string(),
  montoCents: z.number().int(),
  /** False for the charge we keep. True for the ones we propose to debit. */
  debited: z.boolean(),
});

export const TraceSchema = z.object({
  layer: z.enum(['DETERMINISTIC', 'LLM']),
  ruleId: z.string(),
  ruleVersion: z.string(),
  policyVersion: z.string(),
  blockingVersion: z.string(),
  extractorId: z.string(),
  extractorVersion: z.string(),
  reason: z.string(),
  /** The exact inputs the decision was taken on. Redacted patient reference only. */
  inputs: z.record(z.unknown()),
  promptId: z.string().nullable(),
  promptVersion: z.string().nullable(),
  model: z.string().nullable(),
  llmResponse: z.string().nullable(),
  decidedAt: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;

export const FindingSchema = z.object({
  findingId: z.string(),
  tipo: z.enum(FINDING_TYPES),
  /** Salted HMAC of the patient key. The clear member number lives only in the DB. */
  pacienteRef: z.string(),
  paciente: z.object({ cuil: z.string(), suffix: z.string() }),
  practica: z.object({ codigo: z.string(), descripcion: z.string() }),
  fechaServicio: z.string(),
  montoADebitarCents: z.number().int(),
  evidencia: z.array(EvidenceSchema).min(2),
  /** How sure we are. Deterministic findings are 1.0; LLM findings carry its number. */
  confidence: z.number().min(0).max(1),
  traza: TraceSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * Finding identity.
 *
 * The id is a hash of WHAT the finding is about — type, patient, practice, date and
 * the exact set of items — never of when it was produced or in what order the files
 * were read. That is what makes a second run an UPSERT instead of an INSERT, and it is
 * the whole of the idempotency guarantee: the database, not the code, enforces it.
 *
 * Note what is absent: no timestamp, no run id, no document file name. Rename the PDFs
 * and the same finding keeps the same id, because the document identity is its content
 * hash and the item ids are built from that.
 */
export function computeFindingId(
  tipo: FindingType,
  patientKey: string,
  canonicalCode: string,
  serviceDate: string,
  itemIds: readonly string[],
): string {
  const canonical = [tipo, patientKey, canonicalCode, serviceDate, [...itemIds].sort().join(',')].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

/**
 * The charge we keep, and the charges we debit.
 *
 * One of the identical charges is presumably legitimate — the practice did happen once.
 * We keep the first by (document, internal number) and propose the rest for debit. The
 * choice is arbitrary but it must be DETERMINISTIC, or two runs would debit different
 * amounts for the same finding.
 */
export function splitRetainedAndDebited(items: readonly BillingItem[]): {
  retained: BillingItem;
  debited: BillingItem[];
} {
  const [retained, ...debited] = items;
  return { retained: retained!, debited };
}

export interface BuildFindingInput {
  readonly group: CandidateGroup;
  readonly pacienteRef: string;
  readonly confidence: number;
  readonly traza: Trace;
}

export function buildFinding({ group, pacienteRef, confidence, traza }: BuildFindingInput): Finding {
  const { retained, debited } = splitRetainedAndDebited(group.items);
  const first = group.items[0]!;
  return {
    findingId: computeFindingId(
      'PRACTICA_DUPLICADA',
      group.patientKey,
      group.canonicalCode,
      group.serviceDate,
      group.items.map((i) => i.itemId),
    ),
    tipo: 'PRACTICA_DUPLICADA',
    pacienteRef,
    paciente: { cuil: first.cuil, suffix: first.suffix },
    practica: { codigo: group.canonicalCode, descripcion: first.practiceDescription },
    fechaServicio: group.serviceDate,
    montoADebitarCents: debited.reduce((acc, i) => acc + i.totalCents, 0),
    evidencia: group.items.map((item) => ({
      itemId: item.itemId,
      document: item.document,
      page: item.page,
      nroInterno: item.nroInterno,
      serviceDate: item.serviceDate,
      practiceCode: item.practiceCode,
      montoCents: item.totalCents,
      debited: item.itemId !== retained.itemId,
    })),
    confidence,
    traza,
  };
}
