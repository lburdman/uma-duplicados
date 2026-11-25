/**
 * `--help` for every command, in one place.
 *
 * The pipeline is three stages that can run together or separately, plus four
 * diagnostic commands, and the difference between them is not obvious from the script
 * names alone: `detect` cannot open a PDF, `report` has no inputs at all, `ocr` exists
 * only to prove a fallback runs. That distinction lives here rather than in the README
 * so it is available at the moment someone is actually typing the command.
 *
 * Every entry documents the environment variables that change what the command DOES,
 * and omits the ones that only change how it logs. A flag that alters extraction tiers
 * is part of the contract; `LOG_LEVEL` is not, and listing it next to `EXTRACTOR`
 * would suggest they carry the same weight.
 */

/** The section printed by `pnpm start --help`, above the command's own usage. */
const PIPELINE_MAP = `
  Prácticas duplicadas en rendiciones de prestadores

  Tres etapas con SQLite de frontera. Cada una corre sola, y esa separación es
  deliberada: cambiás una regla, corrés 'detect', y adjudicás sobre los mismos bytes
  guardados sin volver a abrir un PDF.

    ./lote/*.pdf                                  out/hallazgos.db
         │                                               │
         ▼                                               ▼
    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
    │ 1. extract   │─────▶│ 2. detect    │─────▶│ 3. report    │
    │ PDF → SQLite │      │ adjudica     │      │ SQLite→JSON  │
    └──────────────┘      └──────────────┘      └──────────────┘
      poppler bbox          reglas + LLM          items.json
      3 tiers               sólo la zona gris      hallazgos.json

  Las tres de una:   pnpm start ./lote
  Sueltas:           pnpm extract ./lote  ·  pnpm detect  ·  pnpm report
  Diagnóstico:       pnpm review  ·  pnpm ocr  ·  pnpm ocr:fallback  ·  pnpm eval
`;

interface HelpEntry {
  /** Invocation line, exactly as it is typed. */
  readonly usage: string;
  /** What the command does, and — where it matters — what it deliberately cannot do. */
  readonly summary: string;
  readonly args?: readonly (readonly [string, string])[];
  readonly env?: readonly (readonly [string, string])[];
  readonly examples?: readonly (readonly [string, string])[];
  /** Prepended to the usage block. Only `start` carries the pipeline map. */
  readonly preamble?: string;
}

const HELP: Readonly<Record<string, HelpEntry>> = {
  start: {
    preamble: PIPELINE_MAP,
    usage: 'pnpm start <directorio-del-lote>',
    summary:
      'Las tres etapas en orden sobre una única base abierta. Todo lo que imprime está\n' +
      '  medido en esta corrida — filas, reconciliación, hallazgos y las dos mitades del\n' +
      '  costo — no copiado del README.',
    args: [['<directorio-del-lote>', 'carpeta con los PDFs. Ej: ./lote']],
    env: [
      ['OUT_DIR', 'dónde escribir base y JSON (default: out/)'],
      ['EXTRACTOR', 'ocr | llm — fuerza un tier para todo el lote. Modo de validación, no de producción'],
      ['OCR_FALLBACK', 'off desarma el tier 2 (OCR local)'],
      ['LLM_OCR', 'off desarma el tier 3 · anthropic usa el cliente real en vez del mock'],
      ['LLM_PROVIDER', 'anthropic usa el modelo real en la capa 2 (default: mock determinístico)'],
      ['LLM_MODEL', 'modelo de la capa 2 (default: claude-opus-5)'],
      ['PII_SALT', 'sal del HMAC que anonimiza la referencia de paciente'],
    ],
    examples: [
      ['pnpm start ./lote', 'la corrida normal: costo de API USD 0'],
      ['LLM_PROVIDER=anthropic pnpm start ./lote', 'capa 2 contra el modelo real'],
      ['EXTRACTOR=ocr OUT_DIR=out-ocr pnpm start ./lote', 'valida el lote entero por OCR sin pisar la salida real'],
    ],
  },

  extract: {
    usage: 'pnpm extract <directorio-del-lote>',
    summary:
      'Etapa 1 sola: PDFs a la base, sin adjudicar nada. Sirve cuando releer el lote es\n' +
      '  la parte cara y querés hacerlo una vez antes de iterar sobre las reglas.',
    args: [['<directorio-del-lote>', 'carpeta con los PDFs. Ej: ./lote']],
    env: [
      ['OUT_DIR', 'dónde escribir la base (default: out/)'],
      ['EXTRACTOR', 'ocr | llm — fuerza un tier para todo el lote (validación)'],
      ['OCR_FALLBACK', 'off desarma el tier 2'],
      ['LLM_OCR', 'off desarma el tier 3 · anthropic usa el cliente real'],
    ],
    examples: [['pnpm extract ./lote', 'lee los 3 PDFs y para ahí']],
  },

  detect: {
    usage: 'pnpm detect',
    summary:
      'Etapa 2 sola: re-adjudica lo que ya está en la base.\n' +
      '  No recibe directorio porque esta etapa NO PUEDE abrir un PDF. Ese es el punto de\n' +
      '  tener extracción y detección en lados opuestos de la base.',
    env: [
      ['OUT_DIR', 'dónde está la base (default: out/)'],
      ['LLM_PROVIDER', 'anthropic usa el modelo real (default: mock determinístico)'],
      ['LLM_MODEL', 'modelo de la capa 2 (default: claude-opus-5)'],
    ],
    examples: [
      ['pnpm detect', 'reglas nuevas sobre los mismos bytes guardados'],
      ['LLM_PROVIDER=anthropic pnpm detect', 'la zona gris contra el modelo real'],
    ],
  },

  report: {
    usage: 'pnpm report',
    summary:
      'Etapa 3 sola: reescribe items.json y hallazgos.json desde lo que la base tenga.\n' +
      '  No recibe argumentos porque no tiene más entrada que las filas guardadas. Los JSON\n' +
      '  son una proyección desde SQL, no un volcado de memoria — por eso dos corridas dan\n' +
      '  bytes idénticos.',
    env: [['OUT_DIR', 'dónde están la base y los JSON (default: out/)']],
    examples: [['pnpm report', 'reproyecta sin re-extraer ni re-adjudicar']],
  },

  review: {
    usage: 'pnpm review',
    summary:
      'La cola de grupos candidatos que el pipeline miró y decidió NO debitar, ordenada\n' +
      '  por cuánta plata hay en juego, con el motivo de cada declinación.\n' +
      '  Existe porque el sesgo del sistema (ADR 0003: la duda no emite) abre un agujero en\n' +
      '  el proceso: si nadie mira estos grupos, "sesgado al falso negativo" se convierte\n' +
      '  en silencio en "ese caso no lo detectamos". Sin PII: el paciente va como referencia\n' +
      '  redactada y la vuelta al papel es documento + página + Nro. Interno.',
    env: [['OUT_DIR', 'dónde está la base (default: out/)']],
    examples: [['pnpm review', 'los 36 grupos declinados, el de mayor monto primero']],
  },

  eval: {
    usage: 'pnpm eval <ground-truth.json> [hallazgos.json]',
    summary:
      'Precisión, recall y F1 contra el archivo que le pases, más qué emitió de más y qué\n' +
      '  se perdió.\n' +
      '  NO trae ground truth ni ruta por defecto a uno. El enunciado promete esperado.json\n' +
      '  y el lote entregado no lo incluye, así que el comando no asume ninguno. La clave de\n' +
      '  comparación es tipo + lista ordenada de itemId: no contiene ningún dato de paciente.',
    args: [
      ['<ground-truth.json>', 'array plano con la forma de hallazgos.json, u objeto con clave "esperados"'],
      ['[hallazgos.json]', 'qué medir (default: out/hallazgos.json)'],
    ],
    examples: [['pnpm eval ./esperado.json', 'mide la última corrida contra ese archivo']],
  },

  ocr: {
    usage: 'pnpm ocr <pdf> [página]',
    summary:
      'Pone la capa de texto y el OCR local lado a lado sobre la misma página.\n' +
      '  Ninguna página del lote necesita OCR, así que sin un comando como éste el fallback\n' +
      '  sería código que nadie vio correr — que es lo mismo que código que no funciona.\n' +
      '  Compara los campos que deciden un débito, no caracteres crudos: que la descripción\n' +
      '  salga distinta está bien; que 340213 se lea 340218 no.',
    args: [
      ['<pdf>', 'ruta al PDF'],
      ['[página]', 'número de página (default: 1)'],
    ],
    examples: [['pnpm ocr lote/detalle_ANONIMIZADO.pdf 1', '254 vs 252 palabras, 15 vs 15 filas, misma suma al centavo']],
  },

  'ocr:fallback': {
    usage: 'pnpm ocr:fallback <pdf> [página] [--no-vision]',
    summary:
      'Baja los tres tiers sobre una página que la capa de texto no puede leer en absoluto.\n' +
      '  Como ninguna página del lote es así, la fabrica: rasteriza una página real y la\n' +
      '  reenvuelve como PDF imagen, lo que borra la capa de texto sin tocar el contenido.\n' +
      '  El tier 1 lee cero palabras y la cadena tiene que ganarse las filas.',
    args: [
      ['<pdf>', 'ruta al PDF'],
      ['[página]', 'número de página (default: 1)'],
      ['--no-vision', 'saltea también el tier 2 — el escenario exacto para el que existe el tier 3'],
    ],
    env: [
      ['LLM_OCR', 'anthropic usa el cliente real en el tier 3 (default: mock)'],
      ['OCR_LLM_MODE', 'batch usa la Batch API (mitad de precio, dentro de la hora)'],
      ['OCR_LLM_MODEL', 'modelo del tier 3 (default: claude-sonnet-5)'],
    ],
    examples: [
      ['pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1', 'sin capa de texto → lo rescata el tier 2'],
      ['pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1 --no-vision', 'sin capa de texto ni OCR → tier 3'],
    ],
  },
};

const COMMON_FOOTER = `Cualquier comando acepta --help.
  Requiere Node >= 22.6 y poppler (brew install poppler).
  README.md · docs/resultados.md (mediciones) · docs/decisions/ (los porqués)`;

/**
 * Column width is per block, not per command. Sharing one width across all three would
 * let a long example command like `EXTRACTOR=ocr OUT_DIR=out-ocr pnpm start ./lote`
 * push the environment variables half a screen to the right for no reason.
 */
function block(title: string, rows: readonly (readonly [string, string])[]): string {
  const pad = Math.max(...rows.map(([left]) => left.length));
  const lines = rows.map(([left, right]) => `    ${left.padEnd(pad)}  ${right}`);
  return `\n  ${title}\n${lines.join('\n')}\n`;
}

export function renderHelp(command: string): string {
  const entry = HELP[command];
  if (!entry) return `sin ayuda para "${command}"\n`;

  let out = entry.preamble ?? '';
  out += `\n  ${entry.usage}\n\n  ${entry.summary}\n`;
  if (entry.args) out += block('Argumentos', entry.args);
  if (entry.env) out += block('Variables de entorno', entry.env);
  if (entry.examples) out += block('Ejemplos', entry.examples);
  out += `\n  ${COMMON_FOOTER}\n\n`;
  return out;
}

/**
 * Called first thing by every command. Help is not an error: it goes to stdout and
 * exits 0, so `pnpm detect --help | less` works and a CI check on exit status does not
 * fail on someone reading the docs.
 */
export function handleHelp(command: string, argv: readonly string[] = process.argv.slice(2)): void {
  if (!argv.some((a) => a === '--help' || a === '-h')) return;
  process.stdout.write(renderHelp(command));
  process.exit(0);
}

export const HELP_COMMANDS = Object.keys(HELP);
