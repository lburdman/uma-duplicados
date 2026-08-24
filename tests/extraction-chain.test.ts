import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChainedDocumentReader } from '../src/extraction/document-reader.ts';
import type { DocumentReader, ReadResult } from '../src/extraction/document-reader.ts';
import { COLUMNS } from '../src/extraction/table.ts';
import type { Cells, RawRow, RowSource } from '../src/extraction/table.ts';
import { parseRow } from '../src/extraction/parse-row.ts';
import { adjudicate, MIN_CONFIDENCE_FOR_FINDING } from '../src/detection/rules.ts';
import { blockCandidates } from '../src/detection/blocking.ts';
import { MockPageExtractionProvider } from '../src/llm/mock-page-extraction-provider.ts';
import { parsePageExtraction, PAGE_EXTRACTION_JSON_SCHEMA } from '../src/llm/page-extraction.ts';
import { createLogger } from '../src/observability/logger.ts';

const capture = () => {
  const lines: string[] = [];
  return { logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }), lines };
};

const cells = (over: Partial<Cells> = {}): Cells => ({
  ...(Object.fromEntries(COLUMNS.map((c) => [c.key, ''])) as Cells),
  nroInterno: '5584920',
  afiliado: '2024327165803',
  fecha: '16/12/2025',
  prestacion: '420101 CONSULTA MEDICA',
  cantidad: '1',
  derechos: '0,00',
  honorarios: '38814,10',
  total: '38814,10',
  ...over,
});

const row = (page: number, nro: string, source: RowSource = 'GEOMETRY'): RawRow => ({
  source, document: 'd.pdf', page, pages: [page], cells: cells({ nroInterno: nro }),
  orphanWords: [], residueCount: 0, ambiguousResidue: false,
});

const reader = (id: string, result: Partial<ReadResult>): DocumentReader => ({
  id, version: '1',
  async read() {
    return { rows: [], printedTotals: { derechos: null, honorarios: null, total: null }, pageCount: 3, pagesWithoutRows: [], ...result };
  },
});

describe('the extraction chain', () => {
  test('a page the first tier read is never offered to a later tier', async () => {
    let secondCalled = false;
    const { logger } = capture();
    const chain = new ChainedDocumentReader({
      logger,
      readers: [
        { id: 'text', build: async () => reader('text', { rows: [row(1, '1'), row(2, '2'), row(3, '3')] }) },
        { id: 'ocr', build: async () => { secondCalled = true; return reader('ocr', {}); } },
      ],
    });
    const result = await chain.read('d.pdf', 'd.pdf');
    assert.equal(result.rows.length, 3);
    assert.equal(secondCalled, false, 'the second tier must not even be built');
    assert.deepEqual([...chain.tiersUsed], ['text']);
  });

  test('a later tier fills only the pages the earlier one left empty', async () => {
    const { logger } = capture();
    const chain = new ChainedDocumentReader({
      logger,
      readers: [
        { id: 'text', build: async () => reader('text', { rows: [row(1, 'a'), row(3, 'c')], pagesWithoutRows: [2] }) },
        // This tier reports rows for every page; only page 2 may be taken from it.
        { id: 'ocr', build: async () => reader('ocr', { rows: [row(1, 'X'), row(2, 'b'), row(3, 'Z')] }) },
      ],
    });
    const result = await chain.read('d.pdf', 'd.pdf');
    assert.deepEqual(result.rows.map((r) => r.cells.nroInterno), ['a', 'b', 'c'], 'document order, and no double-reading');
    assert.deepEqual([...chain.tiersUsed], ['text', 'ocr']);
  });

  test('a tier that cannot be built is skipped once, and does not fail the document', async () => {
    const { logger, lines } = capture();
    let attempts = 0;
    const chain = new ChainedDocumentReader({
      logger,
      readers: [
        { id: 'text', build: async () => reader('text', { rows: [row(1, 'a')], pagesWithoutRows: [2] }) },
        { id: 'vision', build: async () => { attempts++; throw new Error('not a Mac'); } },
        { id: 'llm', build: async () => reader('llm', { rows: [row(2, 'b')] }) },
      ],
    });
    const result = await chain.read('d.pdf', 'd.pdf');
    assert.equal(result.rows.length, 2, 'the third tier still got its chance');
    await chain.read('d.pdf', 'd.pdf');
    assert.equal(attempts, 1, 'a failed tier must not be retried per document');
    assert.equal(lines.filter((l) => l.includes('extraction tier unavailable')).length, 1);
  });

  test('pages no tier could read are reported, not hidden', async () => {
    const { logger } = capture();
    const chain = new ChainedDocumentReader({
      logger,
      readers: [
        { id: 'text', build: async () => reader('text', { pagesWithoutRows: [1, 2] }) },
        { id: 'llm', build: async () => reader('llm', { rows: [row(1, 'a')] }) },
      ],
    });
    const result = await chain.read('d.pdf', 'd.pdf');
    assert.deepEqual([...result.pagesWithoutRows], [2]);
  });
});

describe('rows a model wrote cannot become a debit on their own', () => {
  test('a generative row parses, but lands below the finding floor', () => {
    const geometric = parseRow(row(1, '1'), 'doc');
    const generative = parseRow(row(1, '1', 'GENERATIVE'), 'doc');
    assert.equal(geometric.ok && generative.ok, true);
    if (!geometric.ok || !generative.ok) return;

    assert.equal(geometric.item.confidence, 1);
    assert.ok(generative.item.warnings.includes('GENERATIVE_EXTRACTION'));
    assert.ok(
      generative.item.confidence < MIN_CONFIDENCE_FOR_FINDING,
      `generative confidence ${generative.item.confidence} must sit under the ${MIN_CONFIDENCE_FOR_FINDING} floor`,
    );
  });

  test('...and detection refuses the group it belongs to', () => {
    const items = [row(1, '1', 'GENERATIVE'), row(1, '2', 'GENERATIVE')]
      .map((r, i) => parseRow({ ...r, cells: { ...r.cells, nroInterno: String(i + 1) } }, 'doc'))
      .flatMap((o) => (o.ok ? [o.item] : []));
    assert.equal(items.length, 2);

    const group = blockCandidates(items).groups[0]!;
    const outcome = adjudicate(group, items);
    assert.equal(outcome.verdict, 'NOT_DUPLICATE');
    assert.equal(outcome.ruleId, 'R2-LOW-CONFIDENCE-ABSTAIN');
  });

  test('the same two rows read geometrically DO become a duplicate', () => {
    // The control. Without it the test above only proves the rule fires on something.
    const items = ['1', '2']
      .map((nro) => parseRow(row(1, nro), 'doc'))
      .flatMap((o) => (o.ok ? [o.item] : []));
    const group = blockCandidates(items).groups[0]!;
    assert.equal(adjudicate(group, items).verdict, 'DUPLICATE');
  });
});

describe('the multimodal extraction contract', () => {
  test('the schema sent to the API is derived from the validator', () => {
    const derived = PAGE_EXTRACTION_JSON_SCHEMA as { required: string[]; additionalProperties: boolean };
    assert.deepEqual([...derived.required].sort(), ['printedTotal', 'rows', 'unreadable']);
    assert.equal(derived.additionalProperties, false);
  });

  test('prose instead of JSON fails loudly', () => {
    assert.throws(() => parsePageExtraction('I can see a table with 15 rows.'), /not JSON/);
  });

  test('a row missing a column is rejected — a partial row is not a row', () => {
    assert.throws(
      () => parsePageExtraction('{"rows":[{"nroInterno":"1"}],"printedTotal":null,"unreadable":[]}'),
      /did not match the schema/,
    );
  });

  test('the mock never invents a billing row', async () => {
    // The whole point of this tier is that its output is generated, not measured. A mock
    // that returned plausible charges would make the demo look like extraction worked.
    const results = await new MockPageExtractionProvider().extractPages([
      { page: 1, mediaType: 'image/png', base64: 'AAAA' },
    ]);
    assert.equal(results[0]!.extraction.rows.length, 0);
    assert.equal(results[0]!.extraction.unreadable.length, 1);
    assert.ok(results[0]!.usage.inputTokens > 0, 'but it still accounts for what a page would cost');
  });

  test('batch mode is priced at half', async () => {
    const image = { page: 1, mediaType: 'image/png' as const, base64: 'AAAA' };
    const [sync] = await new MockPageExtractionProvider({ mode: 'sync' }).extractPages([image]);
    const [batch] = await new MockPageExtractionProvider({ mode: 'batch' }).extractPages([image]);
    assert.equal(batch!.usage.projectedCostUsd, sync!.usage.projectedCostUsd! / 2);
  });
});
