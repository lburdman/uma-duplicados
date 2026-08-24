import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountToCents, centsToNumber } from '../src/domain/money.ts';
import { parseServiceDate } from '../src/domain/dates.ts';
import { normalizeMemberId, isValidCuil } from '../src/domain/member.ts';
import { parsePracticeCell, classifyCode } from '../src/domain/practice.ts';

describe('Argentine amounts', () => {
  test('parses to exact cents without touching a float', () => {
    assert.equal(parseAmountToCents('12809,41'), 1280941);
    assert.equal(parseAmountToCents('0,00'), 0);
    assert.equal(parseAmountToCents('12862404,32'), 1286240432);
    assert.equal(parseAmountToCents('1.234.567,89'), 123456789);
  });

  test('rejects anything that is not an amount', () => {
    for (const bad of ['', '12809', '12809.41', 'Página', '12809,4', '1,234']) {
      assert.equal(parseAmountToCents(bad), null, bad);
    }
  });

  test('summing cents avoids the drift that broke the reconciliation in floats', () => {
    const cents = Array.from({ length: 3 }, () => parseAmountToCents('0,10')!);
    assert.equal(cents.reduce((a, b) => a + b, 0), 30);
    assert.equal(centsToNumber(30), 0.3);
  });
});

describe('service dates', () => {
  test('converts dd/mm/yyyy to ISO', () => {
    assert.equal(parseServiceDate('16/12/2025'), '2025-12-16');
  });

  test('refuses a date that does not exist instead of rolling it over', () => {
    assert.equal(parseServiceDate('31/02/2026'), null);
    assert.equal(parseServiceDate('00/01/2026'), null);
    assert.equal(parseServiceDate('2025-12-16'), null);
  });
});

describe('member identity', () => {
  test('splits 13 digits into CUIL and family suffix', () => {
    const member = normalizeMemberId('2024327165803');
    assert.equal(member?.cuil, '20243271658');
    assert.equal(member?.suffix, '03');
    assert.equal(member?.key, '20243271658-03');
    assert.equal(member?.checkDigitValid, true);
  });

  test('the suffix is part of the key, so two siblings are two patients', () => {
    const a = normalizeMemberId('2032650099303')!;
    const b = normalizeMemberId('2032650099302')!;
    assert.equal(a.cuil, b.cuil);
    assert.notEqual(a.key, b.key);
  });

  test('validates the mod-11 check digit', () => {
    assert.equal(isValidCuil('20243271658'), true);
    assert.equal(isValidCuil('27244004062'), true);
    assert.equal(isValidCuil('20243271659'), false);
  });

  test('refuses to guess how to split a member number of the wrong length', () => {
    assert.equal(normalizeMemberId('27185981555'), null);
    assert.equal(normalizeMemberId('27278417528000'), null);
    assert.equal(normalizeMemberId(''), null);
  });
});

describe('billing codes', () => {
  test('reads a practice code and its description', () => {
    const practice = parsePracticeCell('250101 AGENTES FISICOS, FISIOTERAPIA,');
    assert.equal(practice?.code, '250101');
    assert.equal(practice?.kind, 'PRACTICE');
    assert.equal(practice?.description, 'AGENTES FISICOS, FISIOTERAPIA,');
  });

  test('reads a medication code and marks it as such', () => {
    const medication = parsePracticeCell('21068X1 DEXAMETASONA DRAWER 8 mg in');
    assert.equal(medication?.code, '21068X1');
    assert.equal(medication?.kind, 'MEDICATION');
  });

  test('drops a leading name fragment that survived the geometric filter', () => {
    const practice = parsePracticeCell('LEN 21068X1 DEXAMETASONA DRAWER 8 mg in');
    assert.equal(practice?.code, '21068X1');
    assert.equal(practice?.description, 'DEXAMETASONA DRAWER 8 mg in');
    assert.ok(!practice?.description.includes('LEN'));
  });

  test('7-digit practice codes are read whole, not truncated', () => {
    assert.equal(parsePracticeCell('3410126 TOMOGRAFIA DE OTROS ORGANO')?.code, '3410126');
    assert.equal(classifyCode('3410126'), 'PRACTICE');
  });
});
