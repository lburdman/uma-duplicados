import { createLogger } from '../observability/logger.ts';
import { detectOnly } from '../pipeline/run.ts';
import { renderDetection } from './render.ts';

/**
 * Re-adjudicate what is already in the database.
 *
 * Takes no lot directory: this stage cannot open a PDF. Change a rule, run this, and
 * you have new findings over the same stored bytes — which is the point of keeping
 * extraction and detection on opposite sides of the database.
 */
const logger = createLogger();
const detection = await detectOnly({ logger });
process.stdout.write(`\n${renderDetection(detection)}\n\n`);
