import { createHmac } from 'node:crypto';

/**
 * Redaction by design, not by discipline.
 *
 * The rule from the brief is "no log may contain the patient's name or identity
 * document". The member number here CONTAINS the CUIL, which CONTAINS the DNI,
 * so a member number is an identity document. Anything that must appear in a log
 * to correlate events appears as a salted HMAC prefix instead.
 *
 * The scrubber runs on every message and every serialized field, so a future
 * `logger.info(item)` that forgets to redact still cannot leak: the sink itself
 * refuses to emit long digit runs.
 */
const SALT = process.env.PII_SALT ?? 'uma-challenge-local-salt';

/** Stable, non-reversible reference for a patient. Same input -> same ref, always. */
export function patientRef(memberKey: string): string {
  return `pt_${createHmac('sha256', SALT).update(memberKey).digest('hex').slice(0, 12)}`;
}

/** Any run of 8+ digits could be a DNI, a CUIL or a member number. Kill it. */
const LONG_DIGIT_RUN = /\d{8,}/g;
/** CUIL written with separators. */
const FORMATTED_CUIL = /\b\d{2}-\d{7,8}-\d\b/g;

export function scrub(value: string): string {
  return value.replace(FORMATTED_CUIL, '[REDACTED_ID]').replace(LONG_DIGIT_RUN, '[REDACTED_ID]');
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v)]),
    );
  }
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const payload = fields ? (scrubDeep(fields) as Record<string, unknown>) : undefined;
    const suffix = payload && Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : '';
    sink(`${level.padEnd(5)} ${scrub(message)}${suffix}`);
  };

  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
