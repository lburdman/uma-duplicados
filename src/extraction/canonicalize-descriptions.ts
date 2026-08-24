import type { BillingItem } from './billing-item.ts';

/**
 * Defense in depth against name residue reaching items.json.
 *
 * The geometric run separation in table.ts removes essentially all of it, but
 * "essentially all" is not a guarantee I want to make about patient names. On this
 * lot one row still comes out labelled `VALLE` — half a surname — because the name
 * run happened to capture the code.
 *
 * The second line of defense uses a fact the first one cannot see: the description
 * belongs to the CODE, not to the item, and the whole lot votes on it. So when a row
 * both (a) had residue discarded and (b) disagrees with what its code says everywhere
 * else, its description is treated as contaminated and replaced with the code's
 * majority text — with a warning on the item, because a value we substituted is not a
 * value we read.
 *
 * Two conditions keep this narrow. First, only rows that actually had residue removed
 * are eligible. Second, only a FRINGE variant is replaced — one seen at most three
 * times, against a majority at least five times larger. Code 420101 legitimately reads
 * "CONSULTA MEDICA" 328 times and "CONSULTA GINECOLOGICA" 38 times; the second is a
 * real variant of the report, not residue, and it survives even on rows that had a
 * name fragment stripped.
 */
export const RESIDUE_WARNING = 'NAME_RESIDUE_REMOVED';
export const RECOVERED_WARNING = 'DESCRIPTION_RECOVERED_FROM_CODE';
const RECOVERY_PENALTY = 0.05;
/** A variant seen more than this many times is real report text, not residue. */
const FRINGE_MAX_COUNT = 3;
/** ...and the majority must dominate it by at least this factor. */
const MAJORITY_FACTOR = 5;

export function canonicalizeDescriptions(items: readonly BillingItem[]): BillingItem[] {
  const tally = new Map<string, Map<string, number>>();
  for (const item of items) {
    const counts = tally.get(item.practiceCode) ?? new Map<string, number>();
    counts.set(item.practiceDescription, (counts.get(item.practiceDescription) ?? 0) + 1);
    tally.set(item.practiceCode, counts);
  }

  const majority = new Map<string, { text: string; count: number }>();
  for (const [code, counts] of tally) {
    // Ties broken lexicographically so the projection stays byte-stable across runs.
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    majority.set(code, { text: best[0], count: best[1] });
  }

  return items.map((item) => {
    const winner = majority.get(item.practiceCode)!;
    if (winner.text === item.practiceDescription) return item;
    if (!item.warnings.includes(RESIDUE_WARNING)) return item;

    const seen = tally.get(item.practiceCode)!.get(item.practiceDescription) ?? 0;
    if (seen > FRINGE_MAX_COUNT || winner.count < seen * MAJORITY_FACTOR) return item;
    return {
      ...item,
      practiceDescription: winner.text,
      warnings: [...item.warnings, RECOVERED_WARNING],
      confidence: Math.max(0, Number((item.confidence - RECOVERY_PENALTY).toFixed(4))),
    };
  });
}
