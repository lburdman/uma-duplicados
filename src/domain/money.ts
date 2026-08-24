/**
 * Money never lives in a float. Every amount is carried as an integer number of
 * cents from the moment it leaves the PDF until the moment it is printed.
 * That is what lets the reconciliation gate compare against the document's
 * printed TOTAL cent by cent instead of "within an epsilon".
 */
export type Cents = number;

/** Argentine format: `1.234.567,89` — dot groups thousands, comma is the decimal mark. */
const ARGENTINE_AMOUNT = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/;

export function parseAmountToCents(raw: string): Cents | null {
  const text = raw.trim();
  if (!ARGENTINE_AMOUNT.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = text.replace(/[-.]/g, '');
  const [units, decimals] = digits.split(',') as [string, string];
  const cents = Number(units) * 100 + Number(decimals);
  return negative ? -cents : cents;
}

/** Cents -> a JSON number with exactly two decimals (12809.41), never a float sum. */
export function centsToNumber(cents: Cents): number {
  return Number((cents / 100).toFixed(2));
}

export function formatCents(cents: Cents): string {
  return (cents / 100).toFixed(2);
}
