/**
 * Migrations, in order. The array index + 1 is the version.
 *
 * `CREATE TABLE IF NOT EXISTS` is not a migration strategy: it creates what is missing
 * and silently ignores a table that exists with the wrong shape. The moment a column is
 * added, an existing database keeps working right up until a query touches the new
 * column. So the baseline is migration 1 and every later change appends here.
 */
export const MIGRATIONS: readonly string[] = [];

/**
 * Every table's primary key is DERIVED FROM CONTENT, never generated.
 *
 * That is the whole idempotency design. A second run computes the same document id
 * (file content hash), the same item ids (document id + internal number) and the same
 * finding ids (type + patient + practice + date + item set), so every write is an
 * UPSERT onto a row that already exists. There is no "have I seen this before?" check
 * in the application code, because the database cannot represent the duplicate.
 */
export const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  document_id             TEXT PRIMARY KEY,
  file_name               TEXT NOT NULL,
  page_count              INTEGER NOT NULL,
  row_count               INTEGER NOT NULL,
  item_count              INTEGER NOT NULL,
  unextracted_count       INTEGER NOT NULL,
  read_total_cents        INTEGER NOT NULL,
  extracted_total_cents   INTEGER NOT NULL,
  unextracted_total_cents INTEGER NOT NULL,
  printed_total_cents     INTEGER,
  reconciled              INTEGER NOT NULL,
  extractor_id            TEXT NOT NULL,
  extractor_version       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  item_id              TEXT PRIMARY KEY,
  document_id          TEXT NOT NULL REFERENCES documents(document_id),
  page                 INTEGER NOT NULL,
  pages_json           TEXT NOT NULL,
  nro_interno          TEXT NOT NULL,
  patient_key          TEXT NOT NULL,
  cuil                 TEXT NOT NULL,
  suffix               TEXT NOT NULL,
  service_date         TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  practice_code        TEXT NOT NULL,
  practice_description TEXT NOT NULL,
  professional         TEXT NOT NULL,
  service              TEXT NOT NULL,
  quantity             INTEGER NOT NULL,
  derechos_cents       INTEGER NOT NULL,
  honorarios_cents     INTEGER NOT NULL,
  total_cents          INTEGER NOT NULL,
  confidence           REAL NOT NULL,
  warnings_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_block ON items(patient_key, practice_code, service_date);

CREATE TABLE IF NOT EXISTS unextracted_items (
  unextracted_id TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES documents(document_id),
  page           INTEGER NOT NULL,
  nro_interno    TEXT,
  reason         TEXT NOT NULL,
  detail         TEXT NOT NULL,
  total_cents    INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  finding_id              TEXT PRIMARY KEY,
  tipo                    TEXT NOT NULL,
  paciente_ref            TEXT NOT NULL,
  cuil                    TEXT NOT NULL,
  suffix                  TEXT NOT NULL,
  practice_code           TEXT NOT NULL,
  practice_description    TEXT NOT NULL,
  service_date            TEXT NOT NULL,
  monto_a_debitar_cents   INTEGER NOT NULL,
  confidence              REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS finding_items (
  finding_id  TEXT NOT NULL REFERENCES findings(finding_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(item_id),
  debited     INTEGER NOT NULL,
  monto_cents INTEGER NOT NULL,
  PRIMARY KEY (finding_id, item_id)
);

CREATE TABLE IF NOT EXISTS finding_traces (
  finding_id        TEXT PRIMARY KEY REFERENCES findings(finding_id) ON DELETE CASCADE,
  layer             TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  rule_version      TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  blocking_version  TEXT NOT NULL,
  extractor_id      TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  reason            TEXT NOT NULL,
  inputs_json       TEXT NOT NULL,
  prompt_id         TEXT,
  prompt_version    TEXT,
  model             TEXT,
  llm_response      TEXT,
  decided_at        TEXT NOT NULL
);

-- Every adjudicated group, including the ones that produced nothing. This is what
-- answers "why was that group NOT flagged".
CREATE TABLE IF NOT EXISTS decisions (
  group_key      TEXT PRIMARY KEY,
  -- The exact items adjudicated. Stored rather than re-derived, because the group key
  -- holds the CANONICAL practice code and the items hold the code as printed — after
  -- alias collapsing those differ, and a query that rebuilds the key from item columns
  -- silently drops precisely the groups aliasing was introduced to catch.
  item_ids_json  TEXT NOT NULL DEFAULT '[]',
  paciente_ref   TEXT NOT NULL,
  practice_code  TEXT NOT NULL,
  service_date   TEXT NOT NULL,
  item_count     INTEGER NOT NULL,
  pair_count     INTEGER NOT NULL,
  layer          TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  rule_id        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  finding_id     TEXT,
  prompt_id      TEXT,
  prompt_version TEXT,
  model          TEXT,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_usd       REAL NOT NULL
);
`;
