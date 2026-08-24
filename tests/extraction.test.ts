import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { separateTextRuns, assignColumn, groupIntoLines, readColumnAnchors } from '../src/extraction/table.ts';
import type { Word } from '../src/extraction/ports.ts';
import { canonicalizeDescriptions } from '../src/extraction/canonicalize-descriptions.ts';
import type { BillingItem } from '../src/extraction/billing-item.ts';

const word = (text: string, x0: number, x1: number, y0 = 100): Word => ({ text, x0, x1, y0, y1: y0 + 10 });

describe('text run separation', () => {
  test('recovers the real cell when a name run is interleaved with it', () => {
    // Taken verbatim from detalle_(1) page 4. Sorted by x this reads
    // "420101 GINA VANESA CONSULTA MEDICA"; only the geometry says otherwise.
    const result = separateTextRuns([
      word('420101', 527.0, 547.9),
      word('GINA', 529.8, 545.1),
      word('VANESA', 546.5, 571.4),
      word('CONSULTA', 549.8, 582.8),
      word('MEDICA', 584.3, 608.6),
    ]);
    assert.deepEqual(result.kept.map((w) => w.text), ['420101', 'CONSULTA', 'MEDICA']);
    assert.equal(result.residueCount, 2);
    assert.equal(result.ambiguous, false);
  });

  test('a fragment overlapping the code is dropped without eating the description', () => {
    const result = separateTextRuns([
      word('250101', 527.0, 547.9),
      word('ROS', 528.3, 541.8),
      word('AGENTES', 549.6, 579.5),
      word('FISICOS,', 581.2, 607.9),
    ]);
    assert.deepEqual(result.kept.map((w) => w.text), ['250101', 'AGENTES', 'FISICOS,']);
    assert.equal(result.residueCount, 1);
  });

  test('a clean cell is left exactly as it is', () => {
    const result = separateTextRuns([
      word('180110', 527.0, 547.9),
      word('ECOGRAFIA', 549.6, 590.0),
      word('TIROIDEA.', 591.5, 630.0),
    ]);
    assert.equal(result.residueCount, 0);
    assert.equal(result.kept.length, 3);
  });

  test('two plausible codes in one cell is reported as ambiguous, never guessed', () => {
    const result = separateTextRuns([
      word('180110', 527.0, 547.9),
      word('341012', 527.2, 548.1),
    ]);
    assert.equal(result.ambiguous, true);
  });
});

const HEADER = groupIntoLines([
  word('Nro.', 30.0, 41.8, 150), word('Int.', 43.5, 52.2, 150),
  word('Nro.', 64.5, 76.3, 150), word('de', 78.1, 85.0, 150), word('Afiliado', 86.4, 106.9, 150),
  word('Nro.', 132.8, 144.6, 150), word('de', 146.3, 153.2, 150), word('Bono', 155.0, 169.6, 150),
  word('Profesional', 182.2, 213.5, 150), word('Efector', 215.2, 235.1, 150),
  word('Servicio', 304.5, 326.7, 150),
  word('Fecha', 390.8, 408.1, 150),
  word('Apellido', 429.8, 452.0, 150), word('y', 453.7, 456.8, 150), word('Nombre', 458.6, 480.8, 150),
  word('Prestación', 528.0, 557.5, 150),
  word('Cant.', 669.5, 684.4, 150),
  word('Der.', 722.9, 734.7, 150),
  word('Hon.', 766.0, 779.2, 150),
  word('Total', 810.0, 823.2, 150),
])[0]!;

describe('column assignment', () => {
  const anchors = readColumnAnchors(HEADER)!;

  test('the header is recognised in full or not at all', () => {
    assert.ok(anchors);
    assert.equal(anchors.length, 12);
    assert.equal(readColumnAnchors(groupIntoLines([word('Nro.', 30, 41.8), word('Int.', 43.5, 52.2)])[0]!), null);
  });

  test('a header misread by one accent still identifies the page', () => {
    // Measured: Vision read "Afiliado" as "Afíliado" on 1 of 146 pages. Under exact
    // matching that discarded the whole page — 15 rows, 526.452,09 ARS.
    const noisy = groupIntoLines(
      HEADER.words.map((w) => (w.text === 'Afiliado' ? { ...w, text: 'Afíliado' } : w)),
    )[0]!;
    const recovered = readColumnAnchors(noisy);
    assert.ok(recovered, 'one accent must not cost a page');
    assert.equal(recovered.length, 12);
    assert.equal(recovered[1]!.left, anchors[1]!.left, 'anchors must be unchanged');
  });

  test('case and punctuation noise in the header is tolerated too', () => {
    const noisy = groupIntoLines(
      HEADER.words.map((w) => ({ ...w, text: w.text.toUpperCase().replace('.', '') })),
    )[0]!;
    assert.ok(readColumnAnchors(noisy));
  });

  test('a missing header word is still a rejection — this is not fuzzy matching', () => {
    const short = groupIntoLines(HEADER.words.filter((w) => w.text !== 'Bono'))[0]!;
    assert.equal(readColumnAnchors(short), null);
  });

  test('left-aligned text columns go by their left edge', () => {
    assert.equal(assignColumn(word('5584920', 39.2, 63.6), anchors), 'nroInterno');
    assert.equal(assignColumn(word('2024327165803', 65.0, 110.2), anchors), 'afiliado');
    assert.equal(assignColumn(word('16/12/2025', 390.8, 422.0), anchors), 'fecha');
    assert.equal(assignColumn(word('250101', 527.0, 547.9), anchors), 'prestacion');
  });

  test('right-aligned money columns go by their right edge, whatever their width', () => {
    // The trap: a wide Total grows leftward past the Hon. left anchor. A left-edge
    // rule files 264947,00 under Hon. and the document stops reconciling.
    assert.equal(assignColumn(word('12809,41', 797.0, 823.0), anchors), 'total');
    assert.equal(assignColumn(word('264947,00', 779.0, 823.0), anchors), 'total');
    assert.equal(assignColumn(word('185462,90', 690.6, 734.6), anchors), 'derechos');
    assert.equal(assignColumn(word('79484,10', 739.0, 779.0), anchors), 'honorarios');
    assert.equal(assignColumn(word('1', 671.2, 674.7), anchors), 'cantidad');
  });
});

const item = (over: Partial<BillingItem>): BillingItem => ({
  itemId: 'doc:1', documentId: 'doc', document: 'd.pdf', page: 1, pages: [1], nroInterno: '1',
  patientKey: '20243271658-00', cuil: '20243271658', suffix: '00', serviceDate: '2026-01-01',
  kind: 'PRACTICE', practiceCode: '420101', practiceDescription: 'CONSULTA MEDICA',
  professional: '', service: '', quantity: 1, derechosCents: 0, honorariosCents: 100,
  totalCents: 100, confidence: 1, warnings: [], ...over,
});

describe('description canonicalization', () => {
  test('replaces a fringe variant on a row that had residue removed', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item({ itemId: `d:${i}`, practiceCode: '180116', practiceDescription: 'ECOGRAFIA RENAL BILATERAL.' })),
      item({ itemId: 'd:leak', practiceCode: '180116', practiceDescription: 'VALLE', warnings: ['NAME_RESIDUE_REMOVED'] }),
    ];
    const result = canonicalizeDescriptions(items);
    const fixed = result.find((i) => i.itemId === 'd:leak')!;
    assert.equal(fixed.practiceDescription, 'ECOGRAFIA RENAL BILATERAL.');
    assert.ok(fixed.warnings.includes('DESCRIPTION_RECOVERED_FROM_CODE'));
    assert.ok(fixed.confidence < 1);
  });

  test('leaves a real minority variant alone even when the row had residue', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item({ itemId: `a:${i}` })),
      ...Array.from({ length: 8 }, (_, i) => item({ itemId: `b:${i}`, practiceDescription: 'CONSULTA GINECOLOGICA', warnings: ['NAME_RESIDUE_REMOVED'] })),
    ];
    const result = canonicalizeDescriptions(items);
    assert.equal(result.find((i) => i.itemId === 'b:0')!.practiceDescription, 'CONSULTA GINECOLOGICA');
  });

  test('never touches a row that had no residue', () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => item({ itemId: `a:${i}` })),
      item({ itemId: 'b:0', practiceDescription: 'CONSULTA GINECOLOGICA' }),
    ];
    assert.equal(canonicalizeDescriptions(items).find((i) => i.itemId === 'b:0')!.practiceDescription, 'CONSULTA GINECOLOGICA');
  });
});
