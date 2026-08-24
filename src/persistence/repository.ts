import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DecisionRecord } from '../detection/detect.ts';
import type { Finding } from '../detection/finding.ts';
import type { BillingItem, UnextractedItem } from '../extraction/billing-item.ts';
import type { DocumentReport } from '../extraction/extract-document.ts';
import { BASELINE_SQL, MIGRATIONS } from './schema.ts';

/**
 * Persistence.
 *
 * node:sqlite ships with the runtime, so the project has zero native dependencies and
 * no build step — the brief said "a file or SQLite is perfect" and this is the smallest
 * thing that is genuinely a database. The cost is that it is still flagged experimental
 * in Node; the mitigation is that everything here is plain SQL behind one class.
 */
export class Repository {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  /**
   * Bring the database up to the current schema version.
   *
   * The baseline runs first and is idempotent. Then every migration whose version is
   * above the recorded one is applied in order, inside a transaction, and recorded. An
   * empty MIGRATIONS list means the baseline is the whole story — which is true today
   * and stops being true the first time a column moves.
   *
   * `applied_at` is a fixed value, not a clock: it belongs to the schema, not to the
   * run, and a wall clock here would be one more thing that differs between two runs.
   */
  #migrate(): void {
    this.#db.exec(BASELINE_SQL);
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };
    const current = row.version;
    const target = MIGRATIONS.length + 1;
    if (current >= target) return;

    this.#db.exec('BEGIN');
    try {
      for (let version = Math.max(current, 1) + 1; version <= target; version++) {
        const statement = MIGRATIONS[version - 2];
        if (statement) this.#db.exec(statement);
      }
      for (let version = current + 1; version <= target; version++) {
        this.#db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING')
          .run(version, '1970-01-01T00:00:00.000Z');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /** One transaction for the whole lot: a half-written run is worse than no run. */
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  saveDocument(report: DocumentReport): void {
    this.#db
      .prepare(
        `INSERT INTO documents (document_id, file_name, page_count, row_count, item_count,
           unextracted_count, read_total_cents, extracted_total_cents, unextracted_total_cents,
           printed_total_cents, reconciled, extractor_id, extractor_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(document_id) DO UPDATE SET
           file_name = excluded.file_name, page_count = excluded.page_count,
           row_count = excluded.row_count, item_count = excluded.item_count,
           unextracted_count = excluded.unextracted_count,
           read_total_cents = excluded.read_total_cents,
           extracted_total_cents = excluded.extracted_total_cents,
           unextracted_total_cents = excluded.unextracted_total_cents,
           printed_total_cents = excluded.printed_total_cents,
           reconciled = excluded.reconciled, extractor_id = excluded.extractor_id,
           extractor_version = excluded.extractor_version`,
      )
      .run(
        report.documentId, report.document, report.pageCount, report.rowCount, report.itemCount,
        report.unextractedCount, report.readTotalCents, report.extractedTotalCents,
        report.unextractedTotalCents, report.printedTotalCents, report.reconciled ? 1 : 0,
        report.extractorId, report.extractorVersion,
      );
  }

  saveItem(item: BillingItem): void {
    this.#db
      .prepare(
        `INSERT INTO items (item_id, document_id, page, pages_json, nro_interno, patient_key,
           cuil, suffix, service_date, kind, practice_code, practice_description, professional,
           service, quantity, derechos_cents, honorarios_cents, total_cents, confidence, warnings_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item_id) DO UPDATE SET
           page = excluded.page, pages_json = excluded.pages_json,
           patient_key = excluded.patient_key, cuil = excluded.cuil, suffix = excluded.suffix,
           service_date = excluded.service_date, kind = excluded.kind,
           practice_code = excluded.practice_code,
           practice_description = excluded.practice_description,
           professional = excluded.professional, service = excluded.service,
           quantity = excluded.quantity, derechos_cents = excluded.derechos_cents,
           honorarios_cents = excluded.honorarios_cents, total_cents = excluded.total_cents,
           confidence = excluded.confidence, warnings_json = excluded.warnings_json`,
      )
      .run(
        item.itemId, item.documentId, item.page, JSON.stringify(item.pages), item.nroInterno,
        item.patientKey, item.cuil, item.suffix, item.serviceDate, item.kind, item.practiceCode,
        item.practiceDescription, item.professional, item.service, item.quantity,
        item.derechosCents, item.honorariosCents, item.totalCents, item.confidence,
        JSON.stringify(item.warnings),
      );
  }

  saveUnextracted(entry: UnextractedItem): void {
    // No natural key: a row we could not read may not even have an internal number.
    // Hash the facts so a re-run lands on the same row instead of appending.
    const id = createHash('sha256')
      .update([entry.documentId, entry.page, entry.nroInterno ?? '', entry.reason, entry.detail].join('|'))
      .digest('hex')
      .slice(0, 24);
    this.#db
      .prepare(
        `INSERT INTO unextracted_items (unextracted_id, document_id, page, nro_interno, reason, detail, total_cents)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(unextracted_id) DO UPDATE SET detail = excluded.detail, total_cents = excluded.total_cents`,
      )
      .run(id, entry.documentId, entry.page, entry.nroInterno, entry.reason, entry.detail, entry.totalCents);
  }

  saveFinding(finding: Finding): void {
    this.#db
      .prepare(
        `INSERT INTO findings (finding_id, tipo, paciente_ref, cuil, suffix, practice_code,
           practice_description, service_date, monto_a_debitar_cents, confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(finding_id) DO UPDATE SET
           monto_a_debitar_cents = excluded.monto_a_debitar_cents,
           practice_description = excluded.practice_description,
           confidence = excluded.confidence`,
      )
      .run(
        finding.findingId, finding.tipo, finding.pacienteRef, finding.paciente.cuil,
        finding.paciente.suffix, finding.practica.codigo, finding.practica.descripcion,
        finding.fechaServicio, finding.montoADebitarCents, finding.confidence,
      );

    for (const evidence of finding.evidencia) {
      this.#db
        .prepare(
          `INSERT INTO finding_items (finding_id, item_id, debited, monto_cents) VALUES (?,?,?,?)
           ON CONFLICT(finding_id, item_id) DO UPDATE SET
             debited = excluded.debited, monto_cents = excluded.monto_cents`,
        )
        .run(finding.findingId, evidence.itemId, evidence.debited ? 1 : 0, evidence.montoCents);
    }

    const t = finding.traza;
    this.#db
      .prepare(
        `INSERT INTO finding_traces (finding_id, layer, rule_id, rule_version, policy_version,
           blocking_version, extractor_id, extractor_version, reason, inputs_json, prompt_id,
           prompt_version, model, llm_response, decided_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(finding_id) DO UPDATE SET
           layer = excluded.layer, rule_id = excluded.rule_id, rule_version = excluded.rule_version,
           policy_version = excluded.policy_version, blocking_version = excluded.blocking_version,
           extractor_id = excluded.extractor_id, extractor_version = excluded.extractor_version,
           reason = excluded.reason, inputs_json = excluded.inputs_json,
           prompt_id = excluded.prompt_id, prompt_version = excluded.prompt_version,
           model = excluded.model, llm_response = excluded.llm_response,
           decided_at = excluded.decided_at`,
      )
      .run(
        finding.findingId, t.layer, t.ruleId, t.ruleVersion, t.policyVersion, t.blockingVersion,
        t.extractorId, t.extractorVersion, t.reason, JSON.stringify(t.inputs), t.promptId,
        t.promptVersion, t.model, t.llmResponse, t.decidedAt,
      );
  }

  saveDecision(decision: DecisionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO decisions (group_key, item_ids_json, paciente_ref, practice_code, service_date,
           item_count, pair_count, layer, verdict, rule_id, reason, finding_id, prompt_id,
           prompt_version, model, input_tokens, output_tokens, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_key) DO UPDATE SET
           item_ids_json = excluded.item_ids_json,
           item_count = excluded.item_count, pair_count = excluded.pair_count,
           layer = excluded.layer, verdict = excluded.verdict, rule_id = excluded.rule_id,
           reason = excluded.reason, finding_id = excluded.finding_id,
           prompt_id = excluded.prompt_id, prompt_version = excluded.prompt_version,
           model = excluded.model, input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd`,
      )
      .run(
        decision.groupKey, JSON.stringify(decision.itemIds), decision.pacienteRef,
        decision.canonicalCode, decision.serviceDate, decision.itemCount, decision.pairCount, decision.layer, decision.verdict, decision.ruleId,
        decision.reason, decision.findingId, decision.promptId, decision.promptVersion,
        decision.model, decision.inputTokens, decision.outputTokens, decision.costUsd,
      );
  }

  /**
   * Retract findings that this run did not reproduce.
   *
   * Upserting alone guarantees no duplicates. It does NOT guarantee that a finding
   * withdrawn by a rule change disappears — it would sit in the table forever, and an
   * auditor would eventually approve a debit the current rules no longer support.
   *
   * Scoped to the documents this run actually adjudicated. Without the scope, running
   * lot B against a database that already holds lot A silently deletes every one of
   * lot A's findings, because none of them appear in lot B's result. That is not a
   * theoretical edge: it is what happens the second time anyone uses this in anger.
   * A finding is retractable only if we just re-examined the evidence it rests on.
   */
  retractStaleFindings(currentIds: readonly string[], documentIds: readonly string[]): number {
    if (documentIds.length === 0) return 0;
    const keep = new Set(currentIds);
    const placeholders = documentIds.map(() => '?').join(',');
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT f.finding_id
           FROM findings f
           JOIN finding_items fi ON fi.finding_id = f.finding_id
           JOIN items i ON i.item_id = fi.item_id
          WHERE i.document_id IN (${placeholders})`,
      )
      .all(...(documentIds as never[])) as unknown as { finding_id: string }[];
    const stale = rows.map((r) => r.finding_id).filter((id) => !keep.has(id));
    for (const id of stale) {
      this.#db.prepare('DELETE FROM finding_items WHERE finding_id = ?').run(id);
      this.#db.prepare('DELETE FROM finding_traces WHERE finding_id = ?').run(id);
      this.#db.prepare('DELETE FROM findings WHERE finding_id = ?').run(id);
    }
    return stale.length;
  }

  /**
   * Read the items back out.
   *
   * Detection consumes THIS, not the array extraction just built in memory. The round
   * trip through SQL is the point: it makes the database the contract between the two
   * stages instead of a place results are copied to afterwards. Concretely it means
   * detection can be re-run over stored data without opening a PDF — which is exactly
   * what you want the day a rule changes — and that anything lost in serialization is
   * caught by the detector rather than discovered in the report.
   *
   * The ORDER BY is load-bearing: it fixes the order of every downstream tie-break.
   */
  loadItems(): BillingItem[] {
    const rows = this.#db
      .prepare(
        `SELECT i.item_id, i.document_id, d.file_name, i.page, i.pages_json, i.nro_interno,
                i.patient_key, i.cuil, i.suffix, i.service_date, i.kind, i.practice_code,
                i.practice_description, i.professional, i.service, i.quantity,
                i.derechos_cents, i.honorarios_cents, i.total_cents, i.confidence, i.warnings_json
           FROM items i JOIN documents d ON d.document_id = i.document_id
          ORDER BY i.document_id, i.nro_interno`,
      )
      .all() as unknown as ItemRow[];

    return rows.map((row) => ({
      itemId: row.item_id,
      documentId: row.document_id,
      document: row.file_name,
      page: row.page,
      pages: JSON.parse(row.pages_json) as [number, ...number[]],
      nroInterno: row.nro_interno,
      patientKey: row.patient_key,
      cuil: row.cuil,
      suffix: row.suffix,
      serviceDate: row.service_date,
      kind: row.kind as BillingItem['kind'],
      practiceCode: row.practice_code,
      practiceDescription: row.practice_description,
      professional: row.professional,
      service: row.service,
      quantity: row.quantity,
      derechosCents: row.derechos_cents,
      honorariosCents: row.honorarios_cents,
      totalCents: row.total_cents,
      confidence: row.confidence,
      warnings: JSON.parse(row.warnings_json) as string[],
    }));
  }

  loadDocumentReports(): DocumentReport[] {
    const rows = this.#db
      .prepare('SELECT * FROM documents ORDER BY file_name')
      .all() as unknown as DocumentRow[];
    return rows.map((row) => ({
      documentId: row.document_id,
      document: row.file_name,
      pageCount: row.page_count,
      rowCount: row.row_count,
      itemCount: row.item_count,
      unextractedCount: row.unextracted_count,
      readTotalCents: row.read_total_cents,
      extractedTotalCents: row.extracted_total_cents,
      unextractedTotalCents: row.unextracted_total_cents,
      printedTotalCents: row.printed_total_cents,
      reconciliationDeltaCents:
        row.printed_total_cents === null ? null : row.read_total_cents - row.printed_total_cents,
      reconciled: row.reconciled === 1,
      extractorId: row.extractor_id,
      extractorVersion: row.extractor_version,
    }));
  }

  countRows(table: string): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.prepare(sql).all(...(params as never[])) as T[];
  }
}

interface ItemRow {
  item_id: string; document_id: string; file_name: string; page: number; pages_json: string;
  nro_interno: string; patient_key: string; cuil: string; suffix: string; service_date: string;
  kind: string; practice_code: string; practice_description: string; professional: string;
  service: string; quantity: number; derechos_cents: number; honorarios_cents: number;
  total_cents: number; confidence: number; warnings_json: string;
}

interface DocumentRow {
  document_id: string; file_name: string; page_count: number; row_count: number;
  item_count: number; unextracted_count: number; read_total_cents: number;
  extracted_total_cents: number; unextracted_total_cents: number;
  printed_total_cents: number | null; reconciled: number; extractor_id: string;
  extractor_version: string;
}
