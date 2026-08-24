import type { BillingItem } from '../extraction/billing-item.ts';

/**
 * Blocking: reduce 2.169 items to the handful of comparisons worth making.
 *
 * The naive comparison is every item against every other item: ~2.3M pairs here,
 * ~5*10^11 on a million-page day. Instead we group by the key a duplicate must share
 * by definition — same patient, same practice, same service date — and only compare
 * inside a group. That is O(n) with a hash, and it scales linearly.
 *
 * The key deliberately does NOT include the amount. Prices are versioned: code 340213
 * bills 48.609,10 in January and 55.104,96 in February. Two identical practices billed
 * at different prices are still two identical practices.
 *
 * The key deliberately DOES include the family suffix. Same CUIL and different suffix
 * is a sibling, not the same patient — there are 7 such cases in this lot, and every
 * one of them would be a false debit if the key were the CUIL alone.
 */
export const BLOCKING_VERSION = 'blocking/v1';

export interface CandidateGroup {
  readonly key: string;
  readonly patientKey: string;
  readonly canonicalCode: string;
  readonly serviceDate: string;
  readonly items: readonly BillingItem[];
}

export interface BlockingResult {
  readonly groups: readonly CandidateGroup[];
  readonly itemsConsidered: number;
  readonly blocksFormed: number;
  /** Pairs a brute-force comparison would have had to evaluate. */
  readonly pairsAvoided: number;
  /** Pairs actually reachable after blocking. */
  readonly pairsGenerated: number;
  readonly aliasesApplied: number;
}

/**
 * Alias canonicalization.
 *
 * The nomenclator lets the same study be written with a modality digit appended:
 * 341012, 3410121, 3410123 and 3410126 are all "TOMOGRAFIA DE OTROS ORGANOS O
 * REGIONES" at the same price. Comparing raw codes would miss a duplicate written two
 * different ways.
 *
 * The rule is purely structural — a 7-digit code collapses to its 6-digit prefix ONLY
 * when that prefix is itself a code present in the lot — so there is no judgment call
 * and no hand-maintained synonym list to rot. Codes like 342013 and 342014, which look
 * related and are not in a prefix relation, are left alone: their printed descriptions
 * are truncated to the same 27 characters, which is not evidence of anything.
 *
 * Honest result on this lot: it fires on 3 items and changes zero findings. It is here
 * because the next lot is not this lot.
 */
export function buildAliasMap(items: readonly BillingItem[]): Map<string, string> {
  const known = new Set(items.map((i) => i.practiceCode));
  const alias = new Map<string, string>();
  for (const code of known) {
    if (code.length !== 7 || !/^\d{7}$/.test(code)) continue;
    const prefix = code.slice(0, 6);
    if (known.has(prefix)) alias.set(code, prefix);
  }
  return alias;
}

export function blockCandidates(items: readonly BillingItem[]): BlockingResult {
  const alias = buildAliasMap(items);
  let aliasesApplied = 0;

  const buckets = new Map<string, BillingItem[]>();
  for (const item of items) {
    const canonicalCode = alias.get(item.practiceCode) ?? item.practiceCode;
    if (canonicalCode !== item.practiceCode) aliasesApplied++;
    const key = `${item.patientKey}|${canonicalCode}|${item.serviceDate}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: CandidateGroup[] = [];
  let pairsGenerated = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const [patientKey, canonicalCode, serviceDate] = key.split('|') as [string, string, string];
    // Stable order so findings, evidence and JSON output are byte-identical run to run.
    const sorted = [...bucket].sort(
      (a, b) => a.documentId.localeCompare(b.documentId) || a.nroInterno.localeCompare(b.nroInterno),
    );
    groups.push({ key, patientKey, canonicalCode, serviceDate, items: sorted });
    pairsGenerated += (sorted.length * (sorted.length - 1)) / 2;
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));

  const n = items.length;
  return {
    groups,
    itemsConsidered: n,
    blocksFormed: buckets.size,
    pairsAvoided: (n * (n - 1)) / 2 - pairsGenerated,
    pairsGenerated,
    aliasesApplied,
  };
}
