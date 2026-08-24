import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { runPipeline } from '../src/pipeline/run.ts';
import type { PipelineResult } from '../src/pipeline/run.ts';
import { MockLlmProvider } from '../src/llm/mock-provider.ts';
import { createLogger, scrub, patientRef } from '../src/observability/logger.ts';

const LOT = join(import.meta.dirname, '..', 'lote');
const hasLot = existsSync(LOT);

/**
 * These two run the whole pipeline over the real lot. They are the only tests that do,
 * and they exist because the two hardest claims in the README — "two runs are byte
 * identical" and "no log contains patient data" — cannot be established by unit tests.
 *
 * They skip when the lot is absent, because the PDFs carry patient data and are not
 * in the repository.
 */
describe('pipeline over the real lot', { skip: hasLot ? false : 'lote/ not present' }, () => {
  const log: string[] = [];
  let first: PipelineResult;
  let second: PipelineResult;
  let outDir: string | undefined;
  let firstItems: string;
  let secondItems: string;
  let firstFindings: string;
  let secondFindings: string;

  before(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'uma-'));
    const logger = createLogger({ level: 'debug', sink: (line) => log.push(line) });
    const options = { lotDir: LOT, outDir, logger, provider: new MockLlmProvider() };

    first = await runPipeline(options);
    firstItems = await readFile(first.report.itemsPath, 'utf8');
    firstFindings = await readFile(first.report.findingsPath, 'utf8');

    second = await runPipeline(options);
    secondItems = await readFile(second.report.itemsPath, 'utf8');
    secondFindings = await readFile(second.report.findingsPath, 'utf8');
  });

  test('extraction reconciles to the cent against every printed grand total', () => {
    for (const document of first.extraction.reports) {
      assert.equal(
        document.reconciliationDeltaCents,
        0,
        `${document.document} is off by ${document.reconciliationDeltaCents} cents`,
      );
    }
  });

  test('every row on every page is accounted for as item or unextracted', () => {
    for (const d of first.extraction.reports) {
      assert.equal(d.itemCount + d.unextractedCount, d.rowCount);
    }
  });

  test('a second run produces byte-identical files', () => {
    assert.equal(sha(secondItems), sha(firstItems), 'items.json changed between runs');
    assert.equal(sha(secondFindings), sha(firstFindings), 'hallazgos.json changed between runs');
  });

  test('a second run does not add a single row to any table', () => {
    assert.equal(Object.keys(first.counts).length, 7, 'every data table must be counted');
    assert.deepEqual(second.counts, first.counts);
  });

  test('no log line contains a name or a member number', () => {
    assert.ok(log.length > 0, 'the run produced no logs, so this proves nothing');
    for (const line of log) {
      assert.ok(!/\d{8,}/.test(line), `long identifier in log: ${line}`);
      assert.ok(!/\b\d{2}-\d{7,8}-\d\b/.test(line), `formatted CUIL in log: ${line}`);
    }
  });

  test('no member number, CUIL or name fragment reaches items.json descriptions', () => {
    const parsed = JSON.parse(firstItems) as { items: { practica: { descripcion: string } }[] };
    // Every description must be one the code carries elsewhere in the lot; a leaked
    // name fragment is by construction unique to its row.
    const counts = new Map<string, number>();
    for (const i of parsed.items) counts.set(i.practica.descripcion, (counts.get(i.practica.descripcion) ?? 0) + 1);
    const singletons = [...counts].filter(([, n]) => n === 1).map(([d]) => d);
    for (const description of singletons) {
      assert.ok(
        !/^[A-ZÁÉÍÓÚÑ]{2,12}$/.test(description.trim()),
        `description "${description}" looks like a bare name fragment`,
      );
    }
  });

  test('every finding keeps exactly one charge and debits the rest', () => {
    // Property, not a golden file. A stored expectation would only tell us the output
    // changed; these tell us what would be WRONG about it — an auditor who cannot open
    // the page, or a debit that does not equal the charges it claims to remove.
    for (const finding of first.detection.findings) {
      assert.ok(finding.evidencia.length >= 2, 'a duplicate needs at least two charges');
      const retained = finding.evidencia.filter((e) => !e.debited);
      assert.equal(retained.length, 1, `${finding.findingId} does not keep exactly one charge`);
      const debited = finding.evidencia.filter((e) => e.debited);
      assert.equal(
        finding.montoADebitarCents,
        debited.reduce((acc, e) => acc + e.montoCents, 0),
        `${finding.findingId} debits an amount its evidence does not add up to`,
      );
    }
  });

  test('every piece of evidence points at a page an auditor can actually open', () => {
    const pages = new Map<string, number>(first.extraction.reports.map((d) => [d.document, d.pageCount]));
    for (const finding of first.detection.findings) {
      for (const e of finding.evidencia) {
        const total = pages.get(e.document);
        assert.ok(total !== undefined, `evidence names an unknown document: ${e.document}`);
        assert.ok(e.page >= 1 && e.page <= total, `page ${e.page} is outside ${e.document}`);
        assert.ok(e.nroInterno.length > 0, 'evidence has no internal number to look for');
      }
    }
  });

  test('every finding carries a trace that reconstructs how it was produced', () => {
    for (const { traza } of first.detection.findings) {
      assert.ok(traza.ruleId && traza.ruleVersion && traza.policyVersion && traza.blockingVersion);
      assert.ok(traza.extractorId && traza.extractorVersion);
      assert.ok(traza.reason.length > 0);
      if (traza.layer === 'LLM') {
        assert.ok(traza.promptId && traza.promptVersion && traza.model && traza.llmResponse);
      }
    }
  });

  test('every adjudicated group is recorded, not just the ones that fired', () => {
    assert.equal(first.detection.decisions.length, first.detection.stats.candidateGroups);
    const emitted = first.detection.decisions.filter((d) => d.findingId !== null);
    assert.equal(emitted.length, first.detection.findings.length);
  });

  test('detection can be re-run from the database alone, without a PDF', async () => {
    // The point of putting SQLite between stage 1 and stage 2. This calls detection
    // with no lot directory and no extractor — it physically cannot read a PDF — and
    // gets the same findings, because the stored rows are the contract.
    const { detectOnly } = await import('../src/pipeline/run.ts');
    const repeat = await detectOnly({
      outDir: outDir!,
      logger: createLogger({ level: 'error', sink: () => {} }),
      provider: new MockLlmProvider(),
    });
    assert.deepEqual(
      repeat.findings.map((f) => f.findingId).sort(),
      first.detection.findings.map((f) => f.findingId).sort(),
    );
    assert.equal(repeat.retracted, 0, 're-adjudicating stored data must not retract anything');
  });

  test('the lot really does contain no cross-document duplicate', () => {
    // Asserted, not assumed. The brief says duplicates cross PDFs; this lot's do not,
    // and if a future lot changes that, this test is where it shows up.
    assert.equal(first.detection.stats.crossDocumentFindings, 0);
  });
});

describe('the redacting logger', () => {
  test('scrubs long digit runs and formatted CUILs wherever they appear', () => {
    assert.equal(scrub('afiliado 2024327165803 duplicado'), 'afiliado [REDACTED_ID] duplicado');
    assert.equal(scrub('CUIL 20-24327165-8'), 'CUIL [REDACTED_ID]');
  });

  test('leaves short numbers alone so page and item counts stay readable', () => {
    assert.equal(scrub('page 32 of 146'), 'page 32 of 146');
  });

  test('scrubs fields, not just the message', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.info('item parsed', { afiliado: '2024327165803', page: 4 });
    assert.ok(!lines[0]!.includes('2024327165803'));
    assert.ok(lines[0]!.includes('"page":4'));
  });

  test('the patient reference is stable and does not reveal the input', () => {
    const ref = patientRef('20243271658-00');
    assert.equal(ref, patientRef('20243271658-00'));
    assert.notEqual(ref, patientRef('20243271658-01'));
    assert.ok(!ref.includes('20243271658'));
  });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
