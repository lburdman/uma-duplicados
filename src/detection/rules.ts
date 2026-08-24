import type { BillingItem } from '../extraction/billing-item.ts';
import type { CandidateGroup } from './blocking.ts';
import { policyFor, PRACTICE_POLICY_VERSION } from './practice-policy.ts';

/**
 * Layer 1: deterministic adjudication. No LLM, no network, no cost.
 *
 * Each rule has an id and a version and produces exactly one of three verdicts.
 * AMBIGUOUS is a first-class answer, not a failure: it is how a rule says "this needs
 * judgment I do not have", and it is the only thing that reaches the LLM.
 */
export type Verdict = 'DUPLICATE' | 'NOT_DUPLICATE' | 'AMBIGUOUS';

export interface RuleOutcome {
  readonly verdict: Verdict;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly reason: string;
}

/** Items below this never contribute to a debit. A doubtful field loses on appeal. */
export const MIN_CONFIDENCE_FOR_FINDING = 0.8;

const RULES_VERSION = 'rules/v1';

/**
 * Rule order is the policy. The exclusions run first because every one of them
 * protects against a specific false positive we can point at in the lot.
 */
export function adjudicate(group: CandidateGroup, sameDayItems: readonly BillingItem[]): RuleOutcome {
  const rule = (verdict: Verdict, ruleId: string, reason: string): RuleOutcome => ({
    verdict,
    ruleId,
    ruleVersion: RULES_VERSION,
    reason,
  });

  // R1. Medications and materials are not "prácticas". Two doses of dexamethasone on
  // one day is a treatment plan, not a re-bill, and this lot proves it: the repeated
  // medication groups carry DIFFERENT amounts (734,00 + 367,00), which is quantity,
  // not duplication.
  if (group.items.some((i) => i.kind === 'MEDICATION')) {
    return rule('NOT_DUPLICATE', 'R1-MEDICATION-OUT-OF-SCOPE', 'billed item is a medication or material, not a practice');
  }

  // R2. Extraction doubt is not the auditor's problem to discover. If any item in the
  // group is below the confidence floor, we abstain rather than debit on a shaky field.
  const weakest = Math.min(...group.items.map((i) => i.confidence));
  if (weakest < MIN_CONFIDENCE_FOR_FINDING) {
    return rule('NOT_DUPLICATE', 'R2-LOW-CONFIDENCE-ABSTAIN', `lowest item confidence ${weakest} is below ${MIN_CONFIDENCE_FOR_FINDING}`);
  }

  // R3. The nomenclator code is not always the whole practice.
  //
  // 420101 is simply "consulta". In this lot one patient carries 420101 twice on the
  // same day in the same guardia — once as CONSULTA MEDICA and once as CONSULTA
  // GINECOLOGICA. Same code, same price, two different specialists: two legitimate
  // services, and debiting one of them would be a false positive found only by opening
  // the PDF. When the printed descriptions disagree, the code is a container and the
  // description is what distinguishes its contents.
  //
  // Blank descriptions are ignored rather than treated as a third value: an empty cell
  // is a failed read, not evidence of a different practice. And because descriptions
  // are truncated at ~30 characters by the report, this rule can only ever cause a
  // missed duplicate, never an invented one — which is the direction we accept.
  const descriptions = new Set(
    group.items.map((i) => i.practiceDescription.trim()).filter((d) => d !== ''),
  );
  if (descriptions.size > 1) {
    return rule(
      'NOT_DUPLICATE',
      'R3-DIFFERENT-PRACTICE-TEXT',
      `same code ${group.canonicalCode} but different printed practices: ${[...descriptions].map((d) => `"${d}"`).join(' vs ')}`,
    );
  }

  const policy = policyFor(group.canonicalCode);

  // R4. Subsequent-exposure codes exist so a provider CAN bill each extra exposure.
  // The guard is that the first-exposure code must also be there: three "subsequent"
  // charges with no first exposure is not a series, it is something else.
  if (policy.repeatability === 'PER_EXPOSURE') {
    const hasBase = policy.baseCode !== undefined
      && sameDayItems.some((i) => i.practiceCode === policy.baseCode);
    if (hasBase) {
      return rule('NOT_DUPLICATE', 'R4-SUBSEQUENT-EXPOSURE', `${policy.evidence}; first-exposure code ${policy.baseCode} present for the same patient and date`);
    }
    return rule('AMBIGUOUS', 'R4-SUBSEQUENT-EXPOSURE', `subsequent-exposure code without its first-exposure code ${policy.baseCode}`);
  }

  // R5. The practice cannot happen twice in a day. Two charges means one too many.
  if (policy.repeatability === 'SINGLE_PER_DAY') {
    return rule('DUPLICATE', 'R5-SINGLE-PER-DAY', policy.evidence);
  }

  // R6. Everything else — multi-region practices and unclassified codes — is a real
  // question, not a gap in the rules. It goes to the layer that can answer questions.
  return rule('AMBIGUOUS', 'R6-NEEDS-JUDGEMENT', `${policy.repeatability}: ${policy.evidence}`);
}

export const RULE_METADATA = {
  rulesVersion: RULES_VERSION,
  policyVersion: PRACTICE_POLICY_VERSION,
  minConfidence: MIN_CONFIDENCE_FOR_FINDING,
} as const;
