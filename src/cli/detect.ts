import { createLogger } from '../observability/logger.ts';
import { detectOnly } from '../pipeline/run.ts';
import { renderDetection } from './render.ts';
import { handleHelp } from './help.ts';

/**
 * Re-adjudicate what is already in the database.
 *
 * Takes no lot directory: this stage cannot open a PDF. Change a rule, run this, and
 * you have new findings over the same stored bytes — which is the point of keeping
 * extraction and detection on opposite sides of the database.
 */
handleHelp('detect');

const logger = createLogger();
const detection = await detectOnly({ logger });
process.stdout.write(`\n${renderDetection(detection)}\n\n`);
