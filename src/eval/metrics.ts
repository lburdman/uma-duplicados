/**
 * Precision and recall over a set-membership key.
 *
 * The key is the finding's type plus its sorted item ids. Not the finding id — that
 * hash also folds in the patient and the practice code, so a change to how the code is
 * canonicalized would make a correct finding look like a miss. The items are what the
 * auditor actually approves; two findings covering the same items are the same finding.
 */
export interface Expected {
  readonly tipo: string;
  readonly itemIds: readonly string[];
}

export type Actual = Expected;

export interface Metrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly missed: readonly string[];
  readonly spurious: readonly string[];
}

export function matchKey(entry: Expected): string {
  return `${entry.tipo}|${[...entry.itemIds].sort().join(',')}`;
}

export function computeMetrics(expected: readonly Expected[], actual: readonly Actual[]): Metrics {
  const expectedKeys = new Set(expected.map(matchKey));
  const actualKeys = new Set(actual.map(matchKey));

  const truePositives = [...actualKeys].filter((k) => expectedKeys.has(k)).length;
  const falsePositives = actualKeys.size - truePositives;
  const falseNegatives = expectedKeys.size - truePositives;

  // A detector that finds nothing has undefined precision, not perfect precision.
  // Reporting 1.0 there would be flattering and wrong, so an empty set scores 0.
  const precision = actualKeys.size === 0 ? 0 : truePositives / actualKeys.size;
  const recall = expectedKeys.size === 0 ? 0 : truePositives / expectedKeys.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    missed: [...expectedKeys].filter((k) => !actualKeys.has(k)).sort(),
    spurious: [...actualKeys].filter((k) => !expectedKeys.has(k)).sort(),
  };
}
