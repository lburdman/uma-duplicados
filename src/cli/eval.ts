import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computeMetrics } from '../eval/metrics.ts';
import type { Actual, Expected } from '../eval/metrics.ts';

/**
 * `pnpm eval <ground-truth.json> [hallazgos.json]`
 *
 * There is no bundled ground truth and no default path to one. The file is whatever the
 * caller passes in — the official `esperado.json` if it ever arrives, or any file in the
 * same shape. The command holds no opinion about where the truth comes from; it only
 * measures this run against it.
 *
 * Two shapes are accepted, because the official format is unknown: a bare array in the
 * shape of `hallazgos.json`, or an object with an `esperados` array. Both key on the
 * finding's type plus its item ids.
 */
const [, , expectedArg, actualArg] = process.argv;

if (!expectedArg) {
  process.stderr.write(
    'usage: pnpm eval <ground-truth.json> [hallazgos.json]\n\n' +
      'Ground truth is not bundled with this repository. Pass the file to measure against;\n' +
      'it may be a bare array of findings or an object with an "esperados" array. Each entry\n' +
      'needs a "tipo" and either "itemIds" or an "evidencia" array carrying "itemId".\n',
  );
  process.exit(2);
}

const expectedPath = resolve(expectedArg);
const actualPath = resolve(actualArg ?? 'out/hallazgos.json');

const expected = normalize(await readJson(expectedPath, 'Ground truth'));
const actual: Actual[] = normalize(await readJson(actualPath, 'Findings'));

const metrics = computeMetrics(expected, actual);

process.stdout.write(`
Evaluación de hallazgos
  esperado   ${expectedPath}
  obtenido   ${actualPath}

  esperados          ${expected.length}
  emitidos           ${actual.length}
  verdaderos pos.    ${metrics.truePositives}
  falsos positivos   ${metrics.falsePositives}
  falsos negativos   ${metrics.falseNegatives}

  precisión          ${metrics.precision.toFixed(4)}
  recall             ${metrics.recall.toFixed(4)}
  F1                 ${metrics.f1.toFixed(4)}
`);

if (metrics.spurious.length > 0) {
  process.stdout.write(`\n  Emitidos y no esperados:\n${metrics.spurious.map((k: string) => `    ${k}`).join('\n')}\n`);
}
if (metrics.missed.length > 0) {
  process.stdout.write(`\n  Esperados y no emitidos:\n${metrics.missed.map((k: string) => `    ${k}`).join('\n')}\n`);
}
process.stdout.write('\n');

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const cause = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : String(error);
    process.stderr.write(
      `${label} could not be read at ${path} (${cause}).\n` +
        (label === 'Findings' ? 'Run `pnpm start ./lote` first to produce it.\n' : ''),
    );
    process.exit(1);
  }
}

interface RawEntry {
  tipo: string;
  itemIds?: string[];
  evidencia?: { itemId: string }[];
}

function normalize(raw: unknown): Expected[] {
  const entries: RawEntry[] = Array.isArray(raw)
    ? (raw as RawEntry[])
    : ((raw as { esperados?: RawEntry[] }).esperados ?? []);
  return entries.map((entry) => ({
    tipo: entry.tipo,
    itemIds: entry.itemIds ?? (entry.evidencia ?? []).map((e) => e.itemId),
  }));
}
