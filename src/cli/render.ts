import { formatCents } from '../domain/money.ts';
import type { PipelineResult } from '../pipeline/run.ts';
import type { ExtractionSummary } from '../pipeline/stages.ts';

export function renderExtraction(extraction: ExtractionSummary): string {
  const unextractedCents = extraction.reports.reduce((a, d) => a + d.unextractedTotalCents, 0);
  const reconciled = extraction.reports.every((d) => d.reconciled);
  return `Extracción  (etapa 1 · PDFs → SQLite)
  documentos           ${extraction.reports.length}
  filas leídas         ${extraction.reports.reduce((a, d) => a + d.rowCount, 0)}
  ítems extraídos      ${extraction.itemCount}
  ítems no extraídos   ${extraction.unextractedCount} (${formatCents(unextractedCents)} ARS)
  reconcilia contra
  el total impreso     ${reconciled ? 'sí, al centavo, en todos los documentos' : 'NO — ver warnings arriba'}
  extractor            ${extraction.extractorId}@${extraction.extractorVersion}`;
}

export function renderDetection(result: PipelineResult['detection']): string {
  const debited = result.findings.reduce((acc, f) => acc + f.montoADebitarCents, 0);
  return `Detección  (etapa 2 · SQLite → SQLite)
  grupos candidatos    ${result.stats.candidateGroups}
  pares sin LLM        ${result.cost.pairsWithoutLlm}
  pares con LLM        ${result.cost.pairsWithLlm}
  pares nunca compar.  ${result.stats.pairsAvoidedByBlocking} (los elimina el bloqueo)
  hallazgos            ${result.findings.length}
  retractados          ${result.retracted}
  cross-document       ${result.stats.crossDocumentFindings}
  monto a debitar      ${formatCents(debited)} ARS`;
}

/**
 * The cost report.
 *
 * Split by WHERE the money goes, because the two halves are not the same kind of cost
 * and reporting one number hides that.
 *
 * Extraction makes no network call at all — poppler and Vision both run on this machine —
 * so its API cost is zero by construction, not by luck. That is the whole reason a
 * multimodal LLM was rejected for extraction: it would have put a per-page price on the
 * one stage that scales with page count.
 *
 * What extraction does cost is CPU, and at a million pages a day that is the line item
 * that picks the infrastructure. So it is reported in the unit it is actually billed in.
 */
export function renderCost(result: PipelineResult): string {
  const { cost } = result.detection;
  const { extraction } = result;
  const documents = Math.max(1, extraction.reports.length);
  const msPerPage = extraction.elapsedMs / Math.max(1, extraction.pageCount);
  const cpuHoursPerMillion = (msPerPage * 1_000_000) / 3_600_000;

  return `Costo

  Extracción — sin costo de API: nada sale de esta máquina
    motor              ${extraction.extractorId}
    llamadas de red    0
    costo de API       USD 0,00
    cómputo            ${extraction.elapsedMs} ms leyendo ${extraction.pageCount} páginas = ${msPerPage.toFixed(1)} ms/página
                       ≈ ${cpuHoursPerMillion.toFixed(1)} horas-CPU por millón de páginas

  Detección — el único costo de API del pipeline
    provider / modelo  ${cost.provider} / ${cost.model}
    llamadas al LLM    ${cost.llmCalls} (sobre ${result.detection.stats.candidateGroups} grupos candidatos)
    tokens in / out    ${cost.inputTokens} / ${cost.outputTokens}
    costo real         USD ${cost.costUsd.toFixed(6)}${cost.provider === 'mock' ? '  (mock: no se hizo ninguna llamada)' : ''}
    a precio de lista  USD ${cost.projectedCostUsd.toFixed(6)} sobre ${cost.projectedModel}

  Costo de API por documento   USD ${(cost.projectedCostUsd / documents).toFixed(6)}`;
}
