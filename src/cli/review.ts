import { centsToNumber } from '../domain/money.ts';
import { withRepository } from '../pipeline/run.ts';

/**
 * `pnpm review`
 *
 * The queue of candidate groups the pipeline looked at and decided NOT to debit.
 *
 * This exists because the system's own bias creates a hole in the business process.
 * ADR 0003 resolves every doubt against emitting, which is correct — a false positive
 * costs more than a false negative. But the consequence is that money the insurer might
 * be owed gets declined silently, and if nobody ever looks at those groups, "biased
 * toward the false negative" quietly becomes "we do not detect that case at all".
 *
 * So the declined groups are ranked by how much is at stake and printed with the reason
 * they were declined. A rule that shows up repeatedly at the top of this list is a rule
 * worth revisiting; a group that an auditor reviews and confirms is a candidate for the
 * repeatability table, after which layer 1 resolves it for free forever.
 *
 * No PII: the patient is a redacted reference, and the way back to the page is the
 * document, the page number and the internal number.
 */
interface DeclinedRow {
  group_key: string;
  paciente_ref: string;
  practice_code: string;
  service_date: string;
  item_count: number;
  layer: string;
  verdict: string;
  rule_id: string;
  reason: string;
  at_risk_cents: number;
  locations: string;
}

const rows = await withRepository({}, async (repo) =>
  repo.query<DeclinedRow>(
    `SELECT d.group_key, d.paciente_ref, d.practice_code, d.service_date, d.item_count,
            d.layer, d.verdict, d.rule_id, d.reason,
            -- What a debit WOULD have been: everything but the one charge we would keep.
            SUM(i.total_cents) - MAX(i.total_cents) AS at_risk_cents,
            GROUP_CONCAT(doc.file_name || ' p.' || i.page || ' #' || i.nro_interno, ' | ') AS locations
       FROM decisions d
       -- Joined through the item ids the decision recorded, not by rebuilding its key
       -- from item columns: the key holds the CANONICAL practice code and the item
       -- holds the code as printed, and after alias collapsing those differ.
       JOIN json_each(d.item_ids_json) AS ref
       JOIN items i ON i.item_id = ref.value
       JOIN documents doc ON doc.document_id = i.document_id
      WHERE d.finding_id IS NULL
      GROUP BY d.group_key
      ORDER BY at_risk_cents DESC, d.group_key`,
  ),
);

if (rows.length === 0) {
  process.stdout.write('\n  No hay grupos declinados. Corré `pnpm start ./lote` primero.\n\n');
  process.exit(0);
}

/**
 * Not every decline is the same kind of decline, and lumping them together inflates the
 * number into something nobody can act on.
 *
 * A deterministic exclusion is SETTLED: the medication rule is a scope decision, the
 * subsequent-exposure rule rests on 46 of 46 co-occurrences in this lot, and the
 * different-practice rule rests on what the document itself prints. Re-reviewing those
 * by hand buys nothing.
 *
 * A layer-2 decline is UNSETTLED. It means the rules could not decide and a model
 * declined to. That is the queue a human should actually work, and it is the only
 * figure worth calling "at risk".
 */
const unsettled = rows.filter((r) => r.layer === 'LLM');
const settled = rows.filter((r) => r.layer !== 'LLM');
const sum = (list: DeclinedRow[]): number => list.reduce((acc, r) => acc + r.at_risk_cents, 0);

const byRule = new Map<string, { count: number; cents: number }>();
for (const row of rows) {
  const entry = byRule.get(row.rule_id) ?? { count: 0, cents: 0 };
  byRule.set(row.rule_id, { count: entry.count + 1, cents: entry.cents + row.at_risk_cents });
}

process.stdout.write(`
Cola de revisión — grupos candidatos que el pipeline NO debitó

  Sin resolver (los declinó la capa 2, nadie los confirmó)
    grupos           ${unsettled.length}
    monto en juego   ${centsToNumber(sum(unsettled)).toFixed(2)} ARS

  Resueltos por regla determinística (con evidencia, no requieren revisión)
    grupos           ${settled.length}
    monto            ${centsToNumber(sum(settled)).toFixed(2)} ARS

Por regla:
`);
for (const [rule, entry] of [...byRule].sort((a, b) => b[1].cents - a[1].cents)) {
  process.stdout.write(`  ${rule.padEnd(30)} ${String(entry.count).padStart(3)} grupos   ${centsToNumber(entry.cents).toFixed(2)} ARS\n`);
}

process.stdout.write('\nSin resolver, ordenados por monto en juego:\n\n');
for (const row of unsettled) {
  process.stdout.write(
    `  ${centsToNumber(row.at_risk_cents).toFixed(2).padStart(12)} ARS  ${row.practice_code}  ${row.service_date}  x${row.item_count}  [${row.rule_id}]\n` +
      `                    ${row.paciente_ref}  ${row.reason}\n` +
      `                    ${row.locations}\n\n`,
  );
}
