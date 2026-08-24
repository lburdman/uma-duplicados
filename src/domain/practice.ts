/**
 * A "Prestación" cell is a billing code followed by its description:
 *
 *   250101  AGENTES FISICOS, FISIOTERAPIA, ...     <- a practice (nomenclator code)
 *   21068X1 DEXAMETASONA DRAWER 8 mg in ...        <- a medication / material
 *
 * The lot carries both. Practices are 6 or 7 digits; medications carry an `X`
 * modality marker. They are NOT the same kind of thing and the detector must be
 * able to tell them apart: two doses of dexamethasone on the same day is medicine,
 * two identical tomographies on the same day is a duplicate.
 */
export type BilledKind = 'PRACTICE' | 'MEDICATION';

export interface PracticeRef {
  readonly code: string;
  readonly kind: BilledKind;
  readonly description: string;
}

/** 4-8 digits, optionally followed by an X-modality suffix (medications/materials). */
export const BILLING_CODE = /^\d{4,8}(?:[Xx]\d{1,2})?$/;

export function classifyCode(code: string): BilledKind {
  return /[Xx]/.test(code) ? 'MEDICATION' : 'PRACTICE';
}

export function parsePracticeCell(raw: string): PracticeRef | null {
  const tokens = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const index = tokens.findIndex((t) => BILLING_CODE.test(t));
  if (index === -1) return null;
  const code = tokens[index]!.toUpperCase();
  return {
    code,
    kind: classifyCode(code),
    // Anything before the code is anonymization residue that survived the geometric
    // filter; it is a name fragment and is dropped, never stored.
    description: tokens.slice(index + 1).join(' '),
  };
}
