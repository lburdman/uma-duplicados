import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLM_DECISION_JSON_SCHEMA,
  LlmDecisionSchema,
  parseDecision,
} from '../src/llm/decision-schema.ts';
import { MockLlmProvider } from '../src/llm/mock-provider.ts';
import { Repository } from '../src/persistence/repository.ts';
import { parseRow } from '../src/extraction/parse-row.ts';
import type { RawRow, Cells } from '../src/extraction/table.ts';
import { COLUMNS } from '../src/extraction/table.ts';
import type { BillingItem } from '../src/extraction/billing-item.ts';
import type { Finding } from '../src/detection/finding.ts';
import type { DocumentReport } from '../src/extraction/extract-document.ts';

describe('the LLM decision contract', () => {
  test('the JSON Schema sent to the API is derived from the validator, not written twice', () => {
    // If these ever diverge, the API allows something the parser rejects (or worse, the
    // reverse). Deriving one from the other is what makes that impossible.
    const derived = LLM_DECISION_JSON_SCHEMA as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(Object.keys(derived.properties).sort(), ['confidence', 'reason', 'verdict']);
    assert.deepEqual([...derived.required].sort(), ['confidence', 'reason', 'verdict']);
    assert.equal(derived.additionalProperties, false, 'an unconstrained reply is not a contract');
    assert.deepEqual(
      (derived.properties.verdict as { enum: string[] }).enum,
      ['DUPLICATE', 'NOT_DUPLICATE', 'UNCERTAIN'],
    );
  });

  test('a well-formed reply parses', () => {
    const decision = parseDecision('{"verdict":"DUPLICATE","confidence":0.9,"reason":"two identical charges"}');
    assert.equal(decision.verdict, 'DUPLICATE');
  });

  test('prose instead of JSON fails loudly, not silently', () => {
    assert.throws(() => parseDecision('Sure! Here is my answer: it looks duplicated.'), /not JSON/);
  });

  test('a fourth verdict value is rejected even though it is valid JSON', () => {
    assert.throws(() => parseDecision('{"verdict":"MAYBE","confidence":0.5,"reason":"x"}'), /decision schema/);
  });

  test('an out-of-range confidence is rejected', () => {
    assert.throws(() => parseDecision('{"verdict":"DUPLICATE","confidence":7,"reason":"x"}'), /decision schema/);
  });

  test('a missing reason is rejected — a debit with no stated cause is not auditable', () => {
    assert.throws(() => parseDecision('{"verdict":"DUPLICATE","confidence":0.9}'), /decision schema/);
  });

  test('the mock provider answers within the same contract', async () => {
    const response = await new MockLlmProvider().decide({
      promptId: 'p', promptVersion: 'v1',
      prompt: '{"itemCount": 2, "repeatability": "MULTI_REGION"}',
    });
    assert.doesNotThrow(() => parseDecision(response.raw));
    assert.ok(LlmDecisionSchema.safeParse(response.decision).success);
  });
});

const cells = (over: Partial<Cells>): Cells => ({
  ...(Object.fromEntries(COLUMNS.map((c) => [c.key, ''])) as Cells),
  nroInterno: '5584920',
  afiliado: '2024327165803',
  fecha: '16/12/2025',
  prestacion: '250101 AGENTES FISICOS',
  cantidad: '1',
  derechos: '0,00',
  honorarios: '12809,41',
  total: '12809,41',
  ...over,
});

const row = (over: Partial<Cells> = {}): RawRow => ({
  source: 'GEOMETRY', document: 'a.pdf', page: 1, pages: [1], cells: cells(over),
  orphanWords: [], residueCount: 0, ambiguousResidue: false,
});

describe('the BillingItem contract is enforced, not decorative', () => {
  test('a well-formed row produces a schema-valid item', () => {
    const outcome = parseRow(row(), 'doc');
    assert.equal(outcome.ok, true);
  });

  test('a row that would produce an impossible page never becomes an item', () => {
    // Page numbers are positive by schema. Nothing upstream can currently produce a
    // zero, and that is the point: the contract holds regardless of what upstream does.
    const bad: RawRow = { ...row(), page: 0, pages: [0] };
    const outcome = parseRow(bad, 'doc');
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.unextracted.reason, 'MALFORMED_ROW');
  });
});

const report = (documentId: string): DocumentReport => ({
  documentId, document: `${documentId}.pdf`, pageCount: 1, rowCount: 1, itemCount: 1,
  unextractedCount: 0, readTotalCents: 100, extractedTotalCents: 100, unextractedTotalCents: 0,
  printedTotalCents: 100, reconciliationDeltaCents: 0, reconciled: true,
  extractorId: 'e', extractorVersion: '1',
});

const item = (documentId: string, nro: string): BillingItem => ({
  itemId: `${documentId}:${nro}`, documentId, document: `${documentId}.pdf`, page: 1, pages: [1],
  nroInterno: nro, patientKey: '20243271658-00', cuil: '20243271658', suffix: '00',
  serviceDate: '2026-01-15', kind: 'PRACTICE', practiceCode: '420101',
  practiceDescription: 'CONSULTA MEDICA', professional: '', service: '', quantity: 1,
  derechosCents: 0, honorariosCents: 100, totalCents: 100, confidence: 1, warnings: [],
});

const finding = (id: string, documentId: string): Finding => ({
  findingId: id, tipo: 'PRACTICA_DUPLICADA', pacienteRef: 'pt_x',
  paciente: { cuil: '20243271658', suffix: '00' },
  practica: { codigo: '420101', descripcion: 'CONSULTA MEDICA' },
  fechaServicio: '2026-01-15', montoADebitarCents: 100, confidence: 1,
  evidencia: [
    { itemId: `${documentId}:1`, document: `${documentId}.pdf`, page: 1, nroInterno: '1', serviceDate: '2026-01-15', practiceCode: '420101', montoCents: 100, debited: false },
    { itemId: `${documentId}:2`, document: `${documentId}.pdf`, page: 1, nroInterno: '2', serviceDate: '2026-01-15', practiceCode: '420101', montoCents: 100, debited: true },
  ],
  traza: {
    layer: 'DETERMINISTIC', ruleId: 'R5', ruleVersion: 'v1', policyVersion: 'v1',
    blockingVersion: 'v1', extractorId: 'e', extractorVersion: '1', reason: 'r', inputs: {},
    promptId: null, promptVersion: null, model: null, llmResponse: null,
    decidedAt: '1970-01-01T00:00:00.000Z',
  },
});

describe('retraction is scoped to the documents this run adjudicated', () => {
  test('running a second lot does not wipe the first lot findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uma-retract-'));
    const repo = new Repository(join(dir, 'db.sqlite'));
    try {
      for (const doc of ['lotA', 'lotB']) {
        repo.saveDocument(report(doc));
        repo.saveItem(item(doc, '1'));
        repo.saveItem(item(doc, '2'));
        repo.saveFinding(finding(`f-${doc}`, doc));
      }
      assert.equal(repo.countRows('findings'), 2);

      // Re-run lot B only. Its finding still holds; lot A must be untouched.
      const retracted = repo.retractStaleFindings(['f-lotB'], ['lotB']);
      assert.equal(retracted, 0);
      assert.equal(repo.countRows('findings'), 2, 'lot A findings were collateral damage');
    } finally {
      repo.close();
    }
  });

  test('a finding the current run no longer supports IS withdrawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uma-retract2-'));
    const repo = new Repository(join(dir, 'db.sqlite'));
    try {
      repo.saveDocument(report('lotA'));
      repo.saveItem(item('lotA', '1'));
      repo.saveItem(item('lotA', '2'));
      repo.saveFinding(finding('f-old', 'lotA'));

      // A rule change means this run produced nothing for lotA.
      const retracted = repo.retractStaleFindings([], ['lotA']);
      assert.equal(retracted, 1);
      assert.equal(repo.countRows('findings'), 0);
      assert.equal(repo.countRows('finding_items'), 0, 'evidence must go with the finding');
      assert.equal(repo.countRows('finding_traces'), 0);
    } finally {
      repo.close();
    }
  });
});
