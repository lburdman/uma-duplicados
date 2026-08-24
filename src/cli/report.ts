import { reportOnly } from '../pipeline/run.ts';

/**
 * `pnpm report`
 *
 * Stage 3 alone: rewrite both JSON files from whatever the database currently holds. It
 * takes no arguments because it has no inputs other than the stored rows.
 */
const paths = await reportOnly();
process.stdout.write(`\n  ${paths.itemsPath}\n  ${paths.findingsPath}\n\n`);
