import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { patientRef } from '../observability/logger.ts';
import type { LlmProvider, LlmResponse } from '../llm/ports.ts';
import type { CandidateGroup } from './blocking.ts';
import { policyFor } from './practice-policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, '../../prompts/disambiguate-duplicate.v1.md');

export const PROMPT_ID = 'disambiguate-duplicate';
export const PROMPT_VERSION = 'v1';

let cachedTemplate: string | null = null;

async function loadTemplate(): Promise<string> {
  cachedTemplate ??= await readFile(PROMPT_PATH, 'utf8');
  return cachedTemplate;
}

/** Content hash of the prompt file. If the prompt changes, the trace says so. */
export async function promptFingerprint(): Promise<string> {
  return createHash('sha256').update(await loadTemplate()).digest('hex').slice(0, 12);
}

/**
 * What the model is allowed to see.
 *
 * Not the item. A curated projection: the redacted patient reference, the practice,
 * the amounts, the count, and the policy note explaining WHY the deterministic layer
 * could not decide. No name, no member number, no CUIL — the model is a third party
 * and the same PII rules apply to it as to a log file.
 */
export function buildPromptInput(group: CandidateGroup, lotContext: Record<string, unknown>): Record<string, unknown> {
  const policy = policyFor(group.canonicalCode);
  const first = group.items[0]!;
  return {
    pacienteRef: patientRef(group.patientKey),
    serviceDate: group.serviceDate,
    practice: {
      code: group.canonicalCode,
      description: first.practiceDescription,
      repeatability: policy.repeatability,
      policyNote: policy.evidence,
    },
    itemCount: group.items.length,
    amountsCents: group.items.map((i) => i.totalCents),
    amountsIdentical: new Set(group.items.map((i) => i.totalCents)).size === 1,
    documents: [...new Set(group.items.map((i) => i.document))].length,
    lotContext,
  };
}

export interface DisambiguationResult {
  readonly response: LlmResponse;
  readonly prompt: string;
  readonly input: Record<string, unknown>;
}

export async function disambiguate(
  group: CandidateGroup,
  lotContext: Record<string, unknown>,
  provider: LlmProvider,
): Promise<DisambiguationResult> {
  const input = buildPromptInput(group, lotContext);
  const template = await loadTemplate();
  const prompt = template.replace('{{INPUT}}', JSON.stringify(input, null, 2));
  const response = await provider.decide({ promptId: PROMPT_ID, promptVersion: PROMPT_VERSION, prompt });
  return { response, prompt, input };
}
