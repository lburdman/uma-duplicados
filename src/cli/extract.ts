import { createLogger } from '../observability/logger.ts';
import { extractOnly } from '../pipeline/run.ts';
import { renderExtraction } from './render.ts';

/**
 * `pnpm extract <lot-directory>`
 *
 * Stage 1 alone: PDFs into the database, nothing adjudicated. Useful when re-reading the
 * lot is the expensive part and you want it done once before iterating on rules.
 */
const lotDir = process.argv[2];
if (!lotDir) {
  process.stderr.write('usage: pnpm extract <lot-directory>\n');
  process.exit(2);
}

const logger = createLogger();
const extraction = await extractOnly({ lotDir, logger });
process.stdout.write(`\n${renderExtraction(extraction)}\n\n`);
