/**
 * A "Nro. de Afiliado" is a CUIL (11 digits) followed by a family suffix (2 digits).
 *
 *   2024327165803  ->  CUIL 20-24327165-8   suffix 03
 *
 * The suffix is the whole ballgame. Titular is 00; 01, 02, 03... are family
 * members sharing the CUIL of whoever holds the plan. Two siblings billed the
 * same study on the same day look like a duplicate if you group by CUIL alone,
 * and every one of those is a false debit to the provider. So the patient
 * identity is CUIL + suffix, never CUIL.
 */
export interface MemberId {
  /** Digits exactly as printed. */
  readonly raw: string;
  readonly cuil: string;
  readonly suffix: string;
  /** Canonical patient key used for blocking and for finding identity. */
  readonly key: string;
  /** mod-11 check digit verification. Informational: a failure lowers confidence. */
  readonly checkDigitValid: boolean;
}

const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

export function isValidCuil(cuil: string): boolean {
  if (!/^\d{11}$/.test(cuil)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cuil[i]) * CUIL_WEIGHTS[i]!;
  const remainder = sum % 11;
  let expected = 11 - remainder;
  if (expected === 11) expected = 0;
  else if (expected === 10) expected = 9;
  return expected === Number(cuil[10]);
}

export function normalizeMemberId(raw: string): MemberId | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 13) return null;
  const cuil = digits.slice(0, 11);
  const suffix = digits.slice(11);
  return {
    raw: digits,
    cuil,
    suffix,
    key: `${cuil}-${suffix}`,
    checkDigitValid: isValidCuil(cuil),
  };
}
