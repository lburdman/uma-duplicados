import { createLogger } from '../observability/logger.ts';
import { runPipeline } from '../pipeline/run.ts';
import { renderCost, renderDetection, renderExtraction } from './render.ts';
import { handleHelp } from './help.ts';

/**
 * `pnpm start <lot-directory>`
 *
 * The three stages in order over one open database. Everything it prints is measured on
 * this run — row counts, reconciliation, findings, and both halves of the cost — because
 * a summary that restates the README instead of the run is worth nothing.
 */
handleHelp('start');

const lotDir = process.argv[2];
if (!lotDir) {
  process.stderr.write('usage: pnpm start <lot-directory>   (pnpm start --help para el detalle)\n');
  process.exit(2);
}

const logger = createLogger();
const result = await runPipeline({ lotDir, logger });

process.stdout.write(`
────────────────────────────────────────────────────────────
${renderExtraction(result.extraction)}

${renderDetection(result.detection)}

${renderCost(result)}

Salida  (etapa 3 · SQLite → JSON)
  ${result.report.itemsPath}
  ${result.report.findingsPath}

Las tres etapas también corren sueltas:
  pnpm extract ./lote   sólo lee los PDFs a la base
  pnpm detect           re-adjudica sobre lo guardado, sin abrir un PDF
  pnpm report           reproyecta los JSON desde la base
────────────────────────────────────────────────────────────
`);
