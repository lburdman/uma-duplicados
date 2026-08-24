/**
 * Repeatability policy per practice code.
 *
 * This table is the difference between an auditor trusting the output and an auditor
 * checking every line by hand. It answers one question: can this practice legitimately
 * be billed more than once for the same patient on the same day?
 *
 * Every entry cites the evidence it rests on. Codes that are NOT listed default to
 * UNKNOWN, and UNKNOWN never produces a finding on its own — it goes to the LLM layer.
 * That default is deliberate: silence costs a missed duplicate, a wrong guess costs a
 * false debit and the credibility of every other finding in the batch.
 */
export const PRACTICE_POLICY_VERSION = 'practice-policy/v1';

export type Repeatability =
  /** Anatomically singular or encounter-level. A second identical charge is a duplicate. */
  | 'SINGLE_PER_DAY'
  /** Nomenclator code that exists to bill each additional exposure. Repeats are correct. */
  | 'PER_EXPOSURE'
  /** One code covering several regions or billed per region. Repeats may be legitimate. */
  | 'MULTI_REGION'
  /** Not classified. Never auto-decided. */
  | 'UNKNOWN';

export interface PolicyEntry {
  readonly repeatability: Repeatability;
  /** For PER_EXPOSURE: the first-exposure code this one continues. */
  readonly baseCode?: string;
  /** Why this classification holds. Quoted to the auditor and to the LLM. */
  readonly evidence: string;
}

export const PRACTICE_POLICY: Readonly<Record<string, PolicyEntry>> = {
  // --- Radiology: subsequent-exposure codes -------------------------------------
  // Verified on the lot: 46 occurrences of these codes, and in 46 of 46 the patient
  // also carries the matching first-exposure code on the same day. Zero exceptions.
  '340202': {
    repeatability: 'PER_EXPOSURE',
    baseCode: '340201',
    evidence: 'description "POR EXPOSICION SUBISGUIENTE"; continues 340201 (craneo/cara/SPN)',
  },
  '340210': {
    repeatability: 'PER_EXPOSURE',
    baseCode: '340209',
    evidence: 'description "Por exposición subsiguiente"; continues 340209 (Rx columna)',
  },
  '340212': {
    repeatability: 'PER_EXPOSURE',
    baseCode: '340211',
    evidence: 'description "Por segund exposición"; continues 340211 (Rx hombro/pelvis)',
  },
  '340302': {
    repeatability: 'PER_EXPOSURE',
    baseCode: '340301',
    evidence: 'description "exposic subsiguiente"; continues 340301 (Rx torax)',
  },

  // --- Encounter-level and anatomically singular ---------------------------------
  '420101': {
    repeatability: 'SINGLE_PER_DAY',
    evidence: 'CONSULTA MEDICA: one consultation per encounter; a second identical charge is a re-bill',
  },
  '420167': {
    repeatability: 'SINGLE_PER_DAY',
    evidence: 'CONSULTA PEDIATRICA: one consultation per encounter',
  },
  '430109': {
    repeatability: 'SINGLE_PER_DAY',
    evidence: 'OBSERVACION EN GUARDIA O PISO: billed once per stay, not per hour',
  },
  '180110': {
    repeatability: 'SINGLE_PER_DAY',
    evidence: 'ECOGRAFIA TIROIDEA: a single organ; there is no second thyroid to scan',
  },
  '180114': {
    repeatability: 'SINGLE_PER_DAY',
    evidence: 'ECOGRAFIA DE VEJIGA O PROSTATA: the code already covers either target',
  },

  // --- Multi-region: repeats are plausible, so a machine must not decide alone -----
  '340211': {
    repeatability: 'MULTI_REGION',
    evidence: 'Rx homb-humer-pelvis-cadera-femur: one code covering five distinct regions',
  },
  '340213': {
    repeatability: 'MULTI_REGION',
    evidence: 'Rx codo-antebrazo-muñeca-mano-rodilla-pierna-pie: one code covering seven regions',
  },
  '341201': {
    repeatability: 'MULTI_REGION',
    evidence: 'DENSITOMETRIA OSEA POR REGION: the nomenclator bills it per region',
  },
  '180120': {
    repeatability: 'MULTI_REGION',
    evidence: 'ECOGRAFIA MUSCULAR: applies to any muscle group, several may be studied',
  },
  '342013': {
    repeatability: 'MULTI_REGION',
    evidence: 'RESONANCIA MAGNETICA NUCLEAR: region-specific; the printed description is truncated',
  },
  '342014': {
    repeatability: 'MULTI_REGION',
    evidence: 'RESONANCIA MAGNETICA NUCLEAR: region-specific; the printed description is truncated',
  },
};

export function policyFor(code: string): PolicyEntry {
  return PRACTICE_POLICY[code] ?? { repeatability: 'UNKNOWN', evidence: 'code not classified' };
}
