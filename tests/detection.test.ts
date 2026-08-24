import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blockCandidates, buildAliasMap } from '../src/detection/blocking.ts';
import { adjudicate } from '../src/detection/rules.ts';
import { computeFindingId, buildFinding } from '../src/detection/finding.ts';
import { detectDuplicates } from '../src/detection/detect.ts';
import { computeMetrics } from '../src/eval/metrics.ts';
import { createLogger } from '../src/observability/logger.ts';
import type { BillingItem } from '../src/extraction/billing-item.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/ports.ts';

const silent = createLogger({ level: 'error', sink: () => {} });

let seq = 0;
const item = (over: Partial<BillingItem> = {}): BillingItem => {
  seq++;
  return {
    itemId: `docA:${5000 + seq}`, documentId: 'docA', document: 'a.pdf', page: 1, pages: [1],
    nroInterno: String(5000 + seq), patientKey: '20243271658-00', cuil: '20243271658',
    suffix: '00', serviceDate: '2026-01-15', kind: 'PRACTICE', practiceCode: '420101',
    practiceDescription: 'CONSULTA MEDICA', professional: '', service: 'EMERGENTOLOGIA',
    quantity: 1, derechosCents: 0, honorariosCents: 3881410, totalCents: 3881410,
    confidence: 1, warnings: [], ...over,
  };
};

const groupOf = (items: BillingItem[]) => blockCandidates(items).groups[0]!;

describe('blocking', () => {
  test('groups only items sharing patient, practice and date', () => {
    const result = blockCandidates([item(), item(), item({ serviceDate: '2026-01-16' })]);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]!.items.length, 2);
  });

  test('the amount is NOT part of the key, because prices are versioned by period', () => {
    const result = blockCandidates([
      item({ practiceCode: '340213', totalCents: 4860910 }),
      item({ practiceCode: '340213', totalCents: 5510496 }),
    ]);
    assert.equal(result.groups.length, 1, 'a price change must not hide a duplicate');
  });

  test('a 7-digit code collapses onto its 6-digit prefix when that prefix exists', () => {
    const alias = buildAliasMap([item({ practiceCode: '341012' }), item({ practiceCode: '3410126' })]);
    assert.equal(alias.get('3410126'), '341012');
  });

  test('...and does not collapse onto a prefix that is not a real code in the lot', () => {
    const alias = buildAliasMap([item({ practiceCode: '3410126' })]);
    assert.equal(alias.size, 0);
  });

  test('blocking removes essentially all of the quadratic comparison', () => {
    const many = Array.from({ length: 100 }, (_, i) => item({ patientKey: `2024327165${i}-00` }));
    const result = blockCandidates(many);
    assert.equal(result.pairsGenerated, 0);
    assert.equal(result.pairsAvoided, (100 * 99) / 2);
  });
});

describe('deterministic rules', () => {
  test('two identical consultations on one day is a duplicate', () => {
    const group = groupOf([item(), item()]);
    const outcome = adjudicate(group, group.items);
    assert.equal(outcome.verdict, 'DUPLICATE');
    assert.equal(outcome.ruleId, 'R5-SINGLE-PER-DAY');
  });

  // The trap that costs the most: 46 occurrences in the lot, every one legitimate.
  test('a subsequent-exposure code repeats legitimately when its base code is there', () => {
    const base = item({ practiceCode: '340209' });
    const items = [item({ practiceCode: '340210' }), item({ practiceCode: '340210' }), base];
    const group = groupOf(items);
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'NOT_DUPLICATE');
    assert.equal(outcome.ruleId, 'R4-SUBSEQUENT-EXPOSURE');
  });

  test('...but three subsequent exposures with no first exposure is not a series', () => {
    const items = [item({ practiceCode: '340210' }), item({ practiceCode: '340210' })];
    const group = groupOf(items);
    assert.equal(adjudicate(group, items).verdict, 'AMBIGUOUS');
  });

  test('repeated medications are treatment, not re-billing', () => {
    const items = [
      item({ practiceCode: '21068X1', kind: 'MEDICATION', totalCents: 1024929 }),
      item({ practiceCode: '21068X1', kind: 'MEDICATION', totalCents: 512464 }),
    ];
    const group = groupOf(items);
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'NOT_DUPLICATE');
    assert.equal(outcome.ruleId, 'R1-MEDICATION-OUT-OF-SCOPE');
  });

  // Found by opening page 32 of detalle_(1) and reading the row, not by reading code.
  // Code 420101 is just "consulta"; the description carries the specialty.
  test('same code with different printed practices is two services, not a duplicate', () => {
    const items = [
      item({ practiceDescription: 'CONSULTA MEDICA' }),
      item({ practiceDescription: 'CONSULTA GINECOLOGICA' }),
    ];
    const group = groupOf(items);
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'NOT_DUPLICATE');
    assert.equal(outcome.ruleId, 'R3-DIFFERENT-PRACTICE-TEXT');
    assert.match(outcome.reason, /GINECOLOGICA/);
  });

  test('a blank description is a failed read, not a third practice', () => {
    const items = [item({ practiceDescription: 'CONSULTA MEDICA' }), item({ practiceDescription: '' })];
    const group = groupOf(items);
    assert.equal(adjudicate(group, items).verdict, 'DUPLICATE');
  });

  test('a multi-region practice is never auto-debited, it is escalated', () => {
    const items = [item({ practiceCode: '340213' }), item({ practiceCode: '340213' })];
    const group = groupOf(items);
    assert.equal(adjudicate(group, items).verdict, 'AMBIGUOUS');
  });

  test('an unclassified code is escalated, never assumed', () => {
    const items = [item({ practiceCode: '999999' }), item({ practiceCode: '999999' })];
    const group = groupOf(items);
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'AMBIGUOUS');
    assert.equal(outcome.ruleId, 'R6-NEEDS-JUDGEMENT');
  });

  test('a doubtful extraction never becomes a debit', () => {
    const items = [item(), item({ confidence: 0.6, warnings: ['AMOUNT_MISMATCH'] })];
    const group = groupOf(items);
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'NOT_DUPLICATE');
    assert.equal(outcome.ruleId, 'R2-LOW-CONFIDENCE-ABSTAIN');
  });
});

describe('the sibling trap', () => {
  // 7 real cases in the lot. Grouping by CUIL debits all seven by mistake.
  test('same CUIL, same practice, same day, different suffix is two patients', () => {
    const result = blockCandidates([
      item({ patientKey: '20326500993-03', suffix: '03' }),
      item({ patientKey: '20326500993-02', suffix: '02' }),
    ]);
    assert.equal(result.groups.length, 0);
  });
});

describe('finding identity', () => {
  test('is stable across runs and independent of item order', () => {
    const a = computeFindingId('PRACTICA_DUPLICADA', 'p', '420101', '2026-01-15', ['x:2', 'x:1']);
    const b = computeFindingId('PRACTICA_DUPLICADA', 'p', '420101', '2026-01-15', ['x:1', 'x:2']);
    assert.equal(a, b);
  });

  test('changes when the set of items changes', () => {
    const a = computeFindingId('PRACTICA_DUPLICADA', 'p', '420101', '2026-01-15', ['x:1', 'x:2']);
    const b = computeFindingId('PRACTICA_DUPLICADA', 'p', '420101', '2026-01-15', ['x:1', 'x:3']);
    assert.notEqual(a, b);
  });

  test('keeps one charge and debits the rest', () => {
    const group = groupOf([item(), item(), item()]);
    const finding = buildFinding({
      group, pacienteRef: 'pt_x', confidence: 1,
      traza: {
        layer: 'DETERMINISTIC', ruleId: 'R4', ruleVersion: 'v1', policyVersion: 'v1',
        blockingVersion: 'v1', extractorId: 'e', extractorVersion: '1', reason: 'r',
        inputs: {}, promptId: null, promptVersion: null, model: null, llmResponse: null,
        decidedAt: '1970-01-01T00:00:00.000Z',
      },
    });
    assert.equal(finding.evidencia.filter((e) => e.debited).length, 2);
    assert.equal(finding.evidencia.filter((e) => !e.debited).length, 1);
    assert.equal(finding.montoADebitarCents, 3881410 * 2);
  });
});

// Parameter properties are not supported by Node's type stripping, so this is a
// plain factory rather than a class with a constructor shorthand.
const stubProvider = (verdict: 'DUPLICATE' | 'NOT_DUPLICATE' | 'UNCERTAIN'): LlmProvider => ({
  id: 'stub',
  model: 'stub-1',
  async decide(_request: LlmRequest): Promise<LlmResponse> {
    return {
      decision: { verdict, confidence: 0.8, reason: 'stubbed' },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
      model: 'stub-1',
      raw: `{"verdict":"${verdict}"}`,
    };
  },
});

describe('layer 2 routing', () => {
  const ambiguous = () => [item({ practiceCode: '340213' }), item({ practiceCode: '340213' })];

  test('only ambiguous groups reach the model, and the pair counters say so', async () => {
    const items = [...ambiguous(), item(), item()];
    const result = await detectDuplicates({
      items, provider: stubProvider('NOT_DUPLICATE'), logger: silent,
      extractorId: 'e', extractorVersion: '1', decidedAt: '1970-01-01T00:00:00.000Z',
    });
    assert.equal(result.cost.llmCalls, 1);
    assert.equal(result.cost.pairsWithLlm, 1);
    assert.equal(result.cost.pairsWithoutLlm, 1);
    assert.equal(result.findings.length, 1, 'the deterministic duplicate still fires');
  });

  test('a DUPLICATE verdict becomes a finding traced to the prompt and model', async () => {
    const result = await detectDuplicates({
      items: ambiguous(), provider: stubProvider('DUPLICATE'), logger: silent,
      extractorId: 'e', extractorVersion: '1', decidedAt: '1970-01-01T00:00:00.000Z',
    });
    assert.equal(result.findings.length, 1);
    const traza = result.findings[0]!.traza;
    assert.equal(traza.layer, 'LLM');
    assert.equal(traza.promptId, 'disambiguate-duplicate');
    assert.equal(traza.promptVersion, 'v1');
    assert.equal(traza.model, 'stub-1');
    assert.ok(traza.llmResponse);
  });

  test('UNCERTAIN produces no debit — doubt is resolved against emitting', async () => {
    const result = await detectDuplicates({
      items: ambiguous(), provider: stubProvider('UNCERTAIN'), logger: silent,
      extractorId: 'e', extractorVersion: '1', decidedAt: '1970-01-01T00:00:00.000Z',
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.decisions.length, 1, 'but the decision is still recorded');
    assert.equal(result.decisions[0]!.verdict, 'UNCERTAIN');
  });

  test('the model never sees a name, a CUIL or a member number', async () => {
    let seen = '';
    const spy: LlmProvider = {
      id: 'spy', model: 'spy',
      async decide(request) {
        seen = request.prompt;
        return {
          decision: { verdict: 'UNCERTAIN', confidence: 0, reason: '' },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, model: 'spy', raw: '{}',
        };
      },
    };
    await detectDuplicates({
      items: ambiguous(), provider: spy, logger: silent,
      extractorId: 'e', extractorVersion: '1', decidedAt: '1970-01-01T00:00:00.000Z',
    });
    assert.ok(!seen.includes('20243271658'), 'CUIL leaked into the prompt');
    assert.ok(!/\d{11,}/.test(seen), 'a long identifier leaked into the prompt');
  });
});

describe('metrics', () => {
  const e = (ids: string[]) => ({ tipo: 'PRACTICA_DUPLICADA', itemIds: ids });

  test('counts by item set, ignoring order', () => {
    const m = computeMetrics([e(['a', 'b']), e(['c', 'd'])], [e(['b', 'a'])]);
    assert.equal(m.truePositives, 1);
    assert.equal(m.falseNegatives, 1);
    assert.equal(m.precision, 1);
    assert.equal(m.recall, 0.5);
  });

  test('a detector that finds nothing scores zero, not perfect precision', () => {
    const m = computeMetrics([e(['a', 'b'])], []);
    assert.equal(m.precision, 0);
    assert.equal(m.recall, 0);
    assert.equal(m.f1, 0);
  });

  test('reports which findings were spurious and which were missed', () => {
    const m = computeMetrics([e(['a', 'b'])], [e(['x', 'y'])]);
    assert.equal(m.spurious.length, 1);
    assert.equal(m.missed.length, 1);
  });
});
