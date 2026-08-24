import { centsToNumber } from '../domain/money.ts';
import type { Repository } from './repository.ts';

/**
 * JSON output is PROJECTED FROM THE DATABASE, never from the in-memory run.
 *
 * That is deliberate. If the files were written from the objects the pipeline just
 * built, then "the files are identical across runs" would only prove the pipeline is
 * deterministic — it would say nothing about whether the second run wrote the same
 * rows. Reading back through SQL means byte-identical output IS evidence that the
 * upserts landed on the same rows, which is the property the brief asks about.
 *
 * Every query carries an explicit ORDER BY on a stable key. Without it SQLite is free
 * to return rows in any order and idempotency would be a coin flip.
 */

interface ItemRow {
  item_id: string; file_name: string; page: number; pages_json: string; nro_interno: string;
  cuil: string; suffix: string; service_date: string; kind: string; practice_code: string;
  practice_description: string; professional: string; service: string; quantity: number;
  derechos_cents: number; honorarios_cents: number; total_cents: number; confidence: number;
  warnings_json: string;
}

interface UnextractedRow {
  file_name: string; page: number; nro_interno: string | null; reason: string;
  detail: string; total_cents: number | null;
}

interface DocumentRow {
  file_name: string; page_count: number; row_count: number; item_count: number;
  unextracted_count: number; read_total_cents: number; extracted_total_cents: number;
  unextracted_total_cents: number; printed_total_cents: number | null; reconciled: number;
  extractor_id: string; extractor_version: string;
}

export function projectItems(repo: Repository): unknown {
  const documents = repo.query<DocumentRow>(
    `SELECT file_name, page_count, row_count, item_count, unextracted_count, read_total_cents,
            extracted_total_cents, unextracted_total_cents, printed_total_cents, reconciled,
            extractor_id, extractor_version
       FROM documents ORDER BY file_name`,
  );

  const items = repo.query<ItemRow>(
    `SELECT i.item_id, d.file_name, i.page, i.pages_json, i.nro_interno, i.cuil, i.suffix,
            i.service_date, i.kind, i.practice_code, i.practice_description, i.professional,
            i.service, i.quantity, i.derechos_cents, i.honorarios_cents, i.total_cents,
            i.confidence, i.warnings_json
       FROM items i JOIN documents d ON d.document_id = i.document_id
      ORDER BY d.file_name, i.nro_interno`,
  );

  const unextracted = repo.query<UnextractedRow>(
    `SELECT d.file_name, u.page, u.nro_interno, u.reason, u.detail, u.total_cents
       FROM unextracted_items u JOIN documents d ON d.document_id = u.document_id
      ORDER BY d.file_name, u.page, COALESCE(u.nro_interno, ''), u.reason`,
  );

  return {
    documentos: documents.map((d) => ({
      documento: d.file_name,
      paginas: d.page_count,
      filasLeidas: d.row_count,
      itemsExtraidos: d.item_count,
      itemsNoExtraidos: d.unextracted_count,
      totalLeido: centsToNumber(d.read_total_cents),
      totalExtraido: centsToNumber(d.extracted_total_cents),
      totalNoExtraido: centsToNumber(d.unextracted_total_cents),
      totalImpresoEnDocumento: d.printed_total_cents === null ? null : centsToNumber(d.printed_total_cents),
      reconcilia: d.reconciled === 1,
      extractor: `${d.extractor_id}@${d.extractor_version}`,
    })),
    items: items.map((i) => ({
      itemId: i.item_id,
      documento: i.file_name,
      pagina: i.page,
      paginas: JSON.parse(i.pages_json) as number[],
      nroInterno: i.nro_interno,
      paciente: { cuil: i.cuil, sufijo: i.suffix },
      fechaServicio: i.service_date,
      tipoItem: i.kind,
      practica: { codigo: i.practice_code, descripcion: i.practice_description },
      profesional: i.professional,
      servicio: i.service,
      cantidad: i.quantity,
      derechos: centsToNumber(i.derechos_cents),
      honorarios: centsToNumber(i.honorarios_cents),
      total: centsToNumber(i.total_cents),
      confidence: i.confidence,
      warnings: JSON.parse(i.warnings_json) as string[],
    })),
    unextracted: unextracted.map((u) => ({
      documento: u.file_name,
      pagina: u.page,
      nroInterno: u.nro_interno,
      motivo: u.reason,
      detalle: u.detail,
      total: u.total_cents === null ? null : centsToNumber(u.total_cents),
    })),
  };
}

interface FindingRow {
  finding_id: string; tipo: string; paciente_ref: string; cuil: string; suffix: string;
  practice_code: string; practice_description: string; service_date: string;
  monto_a_debitar_cents: number; confidence: number; layer: string; rule_id: string;
  rule_version: string; policy_version: string; blocking_version: string; extractor_id: string;
  extractor_version: string; reason: string; inputs_json: string; prompt_id: string | null;
  prompt_version: string | null; model: string | null; llm_response: string | null;
  decided_at: string;
}

interface EvidenceRow {
  finding_id: string; item_id: string; file_name: string; page: number; nro_interno: string;
  service_date: string; practice_code: string; monto_cents: number; debited: number;
}

export function projectFindings(repo: Repository): unknown {
  const findings = repo.query<FindingRow>(
    `SELECT f.*, t.layer, t.rule_id, t.rule_version, t.policy_version, t.blocking_version,
            t.extractor_id, t.extractor_version, t.reason, t.inputs_json, t.prompt_id,
            t.prompt_version, t.model, t.llm_response, t.decided_at
       FROM findings f JOIN finding_traces t ON t.finding_id = f.finding_id
      ORDER BY f.finding_id`,
  );

  const evidence = repo.query<EvidenceRow>(
    `SELECT fi.finding_id, fi.item_id, d.file_name, i.page, i.nro_interno, i.service_date,
            i.practice_code, fi.monto_cents, fi.debited
       FROM finding_items fi
       JOIN items i ON i.item_id = fi.item_id
       JOIN documents d ON d.document_id = i.document_id
      ORDER BY fi.finding_id, d.file_name, i.nro_interno`,
  );

  const byFinding = new Map<string, EvidenceRow[]>();
  for (const row of evidence) {
    const bucket = byFinding.get(row.finding_id);
    if (bucket) bucket.push(row);
    else byFinding.set(row.finding_id, [row]);
  }

  return findings.map((f) => ({
    findingId: f.finding_id,
    tipo: f.tipo,
    pacienteRef: f.paciente_ref,
    paciente: { cuil: f.cuil, sufijo: f.suffix },
    practica: { codigo: f.practice_code, descripcion: f.practice_description },
    fechaServicio: f.service_date,
    montoADebitar: centsToNumber(f.monto_a_debitar_cents),
    confidence: f.confidence,
    evidencia: (byFinding.get(f.finding_id) ?? []).map((e) => ({
      itemId: e.item_id,
      documento: e.file_name,
      pagina: e.page,
      nroInterno: e.nro_interno,
      fechaServicio: e.service_date,
      practica: e.practice_code,
      monto: centsToNumber(e.monto_cents),
      seDebita: e.debited === 1,
    })),
    traza: {
      capa: f.layer,
      regla: f.rule_id,
      versionRegla: f.rule_version,
      versionPolitica: f.policy_version,
      versionBloqueo: f.blocking_version,
      extractor: `${f.extractor_id}@${f.extractor_version}`,
      motivo: f.reason,
      inputs: JSON.parse(f.inputs_json) as unknown,
      promptId: f.prompt_id,
      promptVersion: f.prompt_version,
      modelo: f.model,
      respuestaLlm: f.llm_response,
      decididoEn: f.decided_at,
    },
  }));
}
