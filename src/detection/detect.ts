import type { BillingItem } from '../extraction/billing-item.ts';
import type { LlmProvider } from '../llm/ports.ts';
import { costUsd as priceOf } from '../llm/pricing.ts';
import { patientRef } from '../observability/logger.ts';
import type { Logger } from '../observability/logger.ts';
import { BLOCKING_VERSION, blockCandidates } from './blocking.ts';
import type { CandidateGroup } from './blocking.ts';
import { disambiguate, PROMPT_ID, PROMPT_VERSION, promptFingerprint } from './disambiguate.ts';
import { buildFinding } from './finding.ts';
import type { Finding, Trace } from './finding.ts';
import { adjudicate, RULE_METADATA } from './rules.ts';
import { PRACTICE_POLICY } from './practice-policy.ts';

export interface DetectionCost {
  /** Pairs the deterministic layer settled. The brief asks for this number. */
  readonly pairsWithoutLlm: number;
  readonly pairsWithLlm: number;
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly provider: string;
  readonly model: string;
  /**
   * What this run WOULD have cost on a real model at list prices.
   *
   * The mock costs nothing, and "USD 0.00 per document" is a useless line in a report.
   * The token counts are real either way, so pricing them against a real model gives
   * the number the brief actually asked for, clearly labelled as a projection.
   */
  readonly projectedCostUsd: number;
  readonly projectedModel: string;
}

/** Model the projection is priced against when the mock provider is in use. */
export const PROJECTION_MODEL = 'claude-opus-5';

/**
 * One record per candidate group, whatever the verdict.
 *
 * Findings answer "why was this debited". An auditor — or a provider's lawyer — will
 * eventually ask the harder question: "why was THAT one not?". A table of findings
 * cannot answer it. This can.
 */
export interface DecisionRecord {
  readonly groupKey: string;
  readonly pacienteRef: string;
  readonly canonicalCode: string;
  readonly serviceDate: string;
  readonly itemCount: number;
  /** The exact items adjudicated, so the decision can be joined back without guessing. */
  readonly itemIds: readonly string[];
  readonly pairCount: number;
  readonly layer: 'DETERMINISTIC' | 'LLM';
  readonly verdict: string;
  readonly ruleId: string;
  readonly reason: string;
  readonly findingId: string | null;
  readonly promptId: string | null;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface DetectionResult {
  readonly findings: readonly Finding[];
  readonly decisions: readonly DecisionRecord[];
  readonly cost: DetectionCost;
  readonly stats: {
    readonly itemsConsidered: number;
    readonly blocksFormed: number;
    readonly candidateGroups: number;
    readonly pairsAvoidedByBlocking: number;
    readonly aliasesApplied: number;
    readonly byRule: Record<string, number>;
    readonly crossDocumentFindings: number;
  };
}

export interface DetectOptions {
  readonly items: readonly BillingItem[];
  readonly provider: LlmProvider;
  readonly logger: Logger;
  readonly extractorId: string;
  readonly extractorVersion: string;
  /** Injected so two runs of the same lot produce byte-identical traces. */
  readonly decidedAt: string;
}

/**
 * Two-layer detection.
 *
 * Layer 1 is rules. It is free, instant and reproducible, and on this lot it settles
 * the overwhelming majority of candidate pairs. Layer 2 is a model, and it only ever
 * sees what layer 1 explicitly declared it could not decide.
 *
 * That order is the cost story AND the correctness story: the expensive, non-
 * deterministic component is the exception path, not the default one.
 */
export async function detectDuplicates(options: DetectOptions): Promise<DetectionResult> {
  const { items, provider, logger, decidedAt } = options;

  const blocking = blockCandidates(items);
  logger.info('blocking complete', {
    items: blocking.itemsConsidered,
    blocks: blocking.blocksFormed,
    candidateGroups: blocking.groups.length,
    pairsGenerated: blocking.pairsGenerated,
    pairsAvoided: blocking.pairsAvoided,
  });

  // Same-day context for the subsequent-exposure rule: it needs to know whether the
  // first-exposure code is present for that patient on that date.
  const sameDay = new Map<string, BillingItem[]>();
  for (const item of items) {
    const key = `${item.patientKey}|${item.serviceDate}`;
    const bucket = sameDay.get(key);
    if (bucket) bucket.push(item);
    else sameDay.set(key, [item]);
  }

  const lotContext = {
    subsequentExposureCodesUsedInLot: countUsage(items, 'PER_EXPOSURE'),
    note: 'A provider that uses subsequent-exposure codes elsewhere knows they exist.',
  };

  const fingerprint = await promptFingerprint();
  const findings: Finding[] = [];
  const decisions: DecisionRecord[] = [];
  const byRule: Record<string, number> = {};
  let pairsWithoutLlm = 0;
  let pairsWithLlm = 0;
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const baseTrace = {
    ruleVersion: RULE_METADATA.rulesVersion,
    policyVersion: RULE_METADATA.policyVersion,
    blockingVersion: BLOCKING_VERSION,
    extractorId: options.extractorId,
    extractorVersion: options.extractorVersion,
    decidedAt,
  };

  for (const group of blocking.groups) {
    const pairs = (group.items.length * (group.items.length - 1)) / 2;
    const context = sameDay.get(`${group.patientKey}|${group.serviceDate}`) ?? [];
    const outcome = adjudicate(group, context);
    byRule[outcome.ruleId] = (byRule[outcome.ruleId] ?? 0) + 1;

    if (outcome.verdict !== 'AMBIGUOUS') {
      pairsWithoutLlm += pairs;
      let findingId: string | null = null;
      if (outcome.verdict === 'DUPLICATE') {
        const finding = buildFinding({
          group,
          pacienteRef: patientRef(group.patientKey),
          confidence: 1,
          traza: {
            ...baseTrace,
            layer: 'DETERMINISTIC',
            ruleId: outcome.ruleId,
            reason: outcome.reason,
            inputs: deterministicInputs(group),
            promptId: null,
            promptVersion: null,
            model: null,
            llmResponse: null,
          } satisfies Trace,
        });
        findings.push(finding);
        findingId = finding.findingId;
      }
      decisions.push({
        ...groupFacts(group, pairs),
        layer: 'DETERMINISTIC',
        verdict: outcome.verdict,
        ruleId: outcome.ruleId,
        reason: outcome.reason,
        findingId,
        promptId: null,
        promptVersion: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      continue;
    }

    // Layer 2. Only what layer 1 refused to decide.
    pairsWithLlm += pairs;
    llmCalls++;
    const { response, input } = await disambiguate(group, lotContext, provider);
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    costUsd += response.usage.costUsd;

    const ruleId = `L2-${response.decision.verdict}`;
    byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;

    // Bias toward the false negative: only an explicit DUPLICATE produces a debit.
    // UNCERTAIN and NOT_DUPLICATE both produce nothing, on purpose.
    let findingId: string | null = null;
    if (response.decision.verdict === 'DUPLICATE') {
      const finding = buildFinding({
        group,
        pacienteRef: patientRef(group.patientKey),
        confidence: response.decision.confidence,
        traza: {
          ...baseTrace,
          layer: 'LLM',
          ruleId: outcome.ruleId,
          reason: response.decision.reason,
          inputs: { ...input, promptFingerprint: fingerprint },
          promptId: PROMPT_ID,
          promptVersion: PROMPT_VERSION,
          model: response.model,
          llmResponse: response.raw,
        } satisfies Trace,
      });
      findings.push(finding);
      findingId = finding.findingId;
    }

    decisions.push({
      ...groupFacts(group, pairs),
      layer: 'LLM',
      verdict: response.decision.verdict,
      ruleId,
      reason: response.decision.reason,
      findingId,
      promptId: PROMPT_ID,
      promptVersion: PROMPT_VERSION,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
    });
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));

  const crossDocumentFindings = findings.filter(
    (f) => new Set(f.evidencia.map((e) => e.document)).size > 1,
  ).length;

  logger.info('detection complete', {
    findings: findings.length,
    pairsWithoutLlm,
    pairsWithLlm,
    llmCalls,
    costUsd: Number(costUsd.toFixed(6)),
  });

  decisions.sort((a, b) => a.groupKey.localeCompare(b.groupKey));

  return {
    findings,
    decisions,
    cost: {
      pairsWithoutLlm,
      pairsWithLlm,
      llmCalls,
      inputTokens,
      outputTokens,
      costUsd: Number(costUsd.toFixed(6)),
      provider: provider.id,
      model: provider.model,
      projectedCostUsd: Number(priceOf(PROJECTION_MODEL, inputTokens, outputTokens).toFixed(6)),
      projectedModel: PROJECTION_MODEL,
    },
    stats: {
      itemsConsidered: blocking.itemsConsidered,
      blocksFormed: blocking.blocksFormed,
      candidateGroups: blocking.groups.length,
      pairsAvoidedByBlocking: blocking.pairsAvoided,
      aliasesApplied: blocking.aliasesApplied,
      byRule,
      crossDocumentFindings,
    },
  };
}

function groupFacts(group: CandidateGroup, pairCount: number) {
  return {
    groupKey: group.key,
    pacienteRef: patientRef(group.patientKey),
    canonicalCode: group.canonicalCode,
    serviceDate: group.serviceDate,
    itemCount: group.items.length,
    itemIds: group.items.map((i) => i.itemId),
    pairCount,
  };
}

function deterministicInputs(group: CandidateGroup): Record<string, unknown> {
  return {
    pacienteRef: patientRef(group.patientKey),
    canonicalCode: group.canonicalCode,
    serviceDate: group.serviceDate,
    itemIds: group.items.map((i) => i.itemId),
    amountsCents: group.items.map((i) => i.totalCents),
    confidences: group.items.map((i) => i.confidence),
  };
}

function countUsage(items: readonly BillingItem[], repeatability: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (PRACTICE_POLICY[item.practiceCode]?.repeatability !== repeatability) continue;
    counts[item.practiceCode] = (counts[item.practiceCode] ?? 0) + 1;
  }
  return counts;
}
