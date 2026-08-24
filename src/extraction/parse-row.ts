import { parseServiceDate } from '../domain/dates.ts';
import { parseAmountToCents } from '../domain/money.ts';
import { normalizeMemberId } from '../domain/member.ts';
import { parsePracticeCell } from '../domain/practice.ts';
import { BillingItemSchema } from './billing-item.ts';
import type { BillingItem, UnextractedItem, UnextractedReason } from './billing-item.ts';
import type { RawRow } from './table.ts';

export type ParseOutcome =
  | { readonly ok: true; readonly item: BillingItem }
  | { readonly ok: false; readonly unextracted: UnextractedItem };

/**
 * Confidence penalties.
 *
 * A warning does not discard the item — it discloses the doubt. The detector uses
 * confidence as a gate: an item below the floor never contributes to a finding,
 * because a debit built on a field we were not sure about is a debit the provider
 * wins on appeal.
 */
const PENALTY = {
  /**
   * A row a model wrote, not one reconstructed from measured coordinates.
   *
   * 0.25 is not a feeling about how good the model is. It is set so that a generative
   * row lands at 0.75, below the 0.8 floor detection requires — which means the third
   * extraction tier can rescue a page for the record, for reconciliation and for a human
   * to read, and still cannot produce a debit on its own. A model that invents a charge
   * costs an audit line, never money. Raising the floor is a human's decision, and it is
   * one line.
   */
  GENERATIVE_SOURCE: 0.25,
  INVALID_CHECK_DIGIT: 0.1,
  AMOUNT_MISMATCH: 0.2,
  ORPHAN_TEXT: 0.15,
  NAME_RESIDUE: 0.02,
  ROW_SPANS_PAGES: 0.05,
  UNEXPECTED_QUANTITY: 0.05,
} as const;

export function parseRow(row: RawRow, documentId: string): ParseOutcome {
  const { cells } = row;

  const rowTotalCents = parseAmountToCents(cells.total);

  const fail = (reason: UnextractedReason, detail: string): ParseOutcome => ({
    ok: false,
    unextracted: {
      documentId,
      document: row.document,
      page: row.page,
      nroInterno: cells.nroInterno || null,
      reason,
      detail,
      totalCents: rowTotalCents,
    },
  });

  // Overlapping runs we could not attribute. Refusing to guess is the whole point.
  if (row.ambiguousResidue) {
    return fail('AMBIGUOUS_OVERLAPPING_TEXT', 'two candidate practice codes in one cell');
  }

  // Patient identity is CUIL + family suffix. A member number that is not exactly
  // 13 digits cannot be split into the two without guessing, and guessing here either
  // merges two siblings into one patient (false debit) or splits one patient in two
  // (missed duplicate). Neither is acceptable, so the item is declared unextracted.
  if (cells.afiliado.trim() === '') return fail('MISSING_MEMBER_ID', 'member column empty');
  const member = normalizeMemberId(cells.afiliado);
  if (!member) {
    return fail(
      'MALFORMED_MEMBER_ID',
      `expected 13 digits (11 CUIL + 2 suffix), got ${cells.afiliado.replace(/\D/g, '').length}`,
    );
  }

  if (cells.fecha.trim() === '') return fail('MISSING_SERVICE_DATE', 'date column empty');
  const serviceDate = parseServiceDate(cells.fecha);
  if (!serviceDate) return fail('MALFORMED_SERVICE_DATE', `unparseable date: ${cells.fecha}`);

  const practice = parsePracticeCell(cells.prestacion);
  if (!practice) return fail('MISSING_PRACTICE_CODE', 'practice cell has no leading code');

  const derechosCents = parseAmountToCents(cells.derechos);
  const honorariosCents = parseAmountToCents(cells.honorarios);
  const totalCents = rowTotalCents;
  if (derechosCents === null || honorariosCents === null || totalCents === null) {
    return fail('MALFORMED_AMOUNT', 'one of Der./Hon./Total is not an Argentine amount');
  }

  const quantity = Number(cells.cantidad.trim());
  if (!Number.isInteger(quantity)) {
    return fail('MALFORMED_QUANTITY', `unparseable quantity: ${cells.cantidad}`);
  }

  const warnings: string[] = [];
  let confidence = 1;
  const penalize = (warning: string, amount: number): void => {
    warnings.push(warning);
    confidence -= amount;
  };

  if (row.source === 'GENERATIVE') penalize('GENERATIVE_EXTRACTION', PENALTY.GENERATIVE_SOURCE);
  if (!member.checkDigitValid) penalize('INVALID_CHECK_DIGIT', PENALTY.INVALID_CHECK_DIGIT);
  if (derechosCents + honorariosCents !== totalCents) {
    penalize('AMOUNT_MISMATCH', PENALTY.AMOUNT_MISMATCH);
  }
  if (row.orphanWords.length > 0) penalize('ORPHAN_TEXT', PENALTY.ORPHAN_TEXT);
  if (row.residueCount > 0) penalize('NAME_RESIDUE_REMOVED', PENALTY.NAME_RESIDUE);
  if (row.pages.length > 1) penalize('ROW_SPANS_PAGES', PENALTY.ROW_SPANS_PAGES);
  if (quantity !== 1) penalize('UNEXPECTED_QUANTITY', PENALTY.UNEXPECTED_QUANTITY);

  const candidate = {
      itemId: `${documentId}:${cells.nroInterno}`,
      documentId,
      document: row.document,
      page: row.page,
      pages: row.pages as [number, ...number[]],
      nroInterno: cells.nroInterno,
      patientKey: member.key,
      cuil: member.cuil,
      suffix: member.suffix,
      serviceDate,
      kind: practice.kind,
      practiceCode: practice.code,
      practiceDescription: practice.description,
      professional: cells.profesional.trim(),
      service: cells.servicio.trim(),
      quantity,
      derechosCents,
      honorariosCents,
      totalCents,
      confidence: Math.max(0, Number(confidence.toFixed(4))),
      warnings,
  };

  // The schema is the contract, so it is enforced rather than admired. Everything above
  // builds the object field by field; this is the one place that checks the result is
  // actually a BillingItem before it reaches the database, the blocking key and the
  // auditor's evidence. A row that fails here is declared unextracted — the same answer
  // this pipeline gives to every other thing it could not read with confidence.
  const validated = BillingItemSchema.safeParse(candidate);
  if (!validated.success) {
    return fail('MALFORMED_ROW', `parsed row failed schema validation: ${validated.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }

  return { ok: true, item: validated.data };
}
