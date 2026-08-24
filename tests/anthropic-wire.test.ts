import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicPageExtractionProvider } from '../src/llm/anthropic-page-extraction-provider.ts';
import { AnthropicLlmProvider } from '../src/llm/anthropic-provider.ts';
import { PAGE_EXTRACTION_JSON_SCHEMA } from '../src/llm/page-extraction.ts';

/**
 * The real client, against a server that speaks the real wire protocol.
 *
 * A mock provider proves the pipeline's plumbing. It proves nothing about the code that
 * actually talks to Anthropic — the request shape, the image block, the constrained
 * output config, the usage fields, the batch result ordering. That code is exercised
 * exactly once: in production, on the day someone sets a key. These tests move that day
 * forward by pointing the genuine SDK at localhost.
 *
 * `baseURL` is the same seam that makes the architecture key-ready: the provider builds a
 * bare `new Anthropic()`, which resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
 * then an OAuth profile. Nothing here is special-cased for testing.
 */
let server: Server;
let baseURL: string;
const seen: { path: string; body: any }[] = [];
let polls = 0;

const PAGE_REPLY = JSON.stringify({
  rows: [
    {
      nroInterno: '5584920', afiliado: '2024327165803', bono: '', profesional: 'EQUIPO KINESIOLOGIA',
      servicio: 'Kinesiología', fecha: '16/12/2025', prestacion: '250101 AGENTES FISICOS',
      cantidad: '1', derechos: '0,00', honorarios: '12809,41', total: '12809,41',
    },
  ],
  printedTotal: null,
  unreadable: [],
});

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');

      if (req.url === '/v1/messages') {
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: body.output_config?.format?.schema?.properties?.rows ? PAGE_REPLY : '{"verdict":"DUPLICATE","confidence":0.9,"reason":"two identical charges"}' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1100, output_tokens: 40 },
        }));
        return;
      }
      if (req.url === '/v1/messages/batches' && req.method === 'POST') {
        res.end(JSON.stringify({ id: 'batch_1', type: 'message_batch', processing_status: 'in_progress', results_url: null }));
        return;
      }
      if (req.url === '/v1/messages/batches/batch_1' && req.method === 'GET') {
        // First poll says in_progress, exactly as a real submission does.
        polls++;
        res.end(JSON.stringify({
          id: 'batch_1', type: 'message_batch',
          processing_status: polls > 1 ? 'ended' : 'in_progress',
          results_url: polls > 1 ? `${baseURL}/v1/messages/batches/batch_1/results` : null,
        }));
        return;
      }
      if (req.url?.includes('/results')) {
        res.setHeader('content-type', 'application/x-jsonl');
        // Deliberately OUT of page order: the provider must key by custom_id.
        res.end(
          [2, 1]
            .map((page) => JSON.stringify({
              custom_id: `page-${page}`,
              result: { type: 'succeeded', message: { id: `msg_${page}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: PAGE_REPLY }], usage: { input_tokens: 1100, output_tokens: 40 } } },
            }))
            .join('\n'),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseURL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

const client = (): Anthropic => new Anthropic({ apiKey: 'sk-test-not-a-real-key', baseURL });
const batchProvider = () => new AnthropicPageExtractionProvider({ client: client(), mode: 'batch', batchPollMs: 1 });
const image = (page: number) => ({ page, mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' });

describe('the real Anthropic client, on the wire', () => {
  test('the multimodal tier sends an image block and a constrained output config', async () => {
    seen.length = 0;
    const provider = new AnthropicPageExtractionProvider({ client: client(), model: 'claude-sonnet-5' });
    const [result] = await provider.extractPages([image(1)]);

    const request = seen.find((s) => s.path === '/v1/messages')!.body;
    assert.equal(request.model, 'claude-sonnet-5', 'transcription runs on Sonnet, not Opus');
    const content = request.messages[0].content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/png');
    assert.equal(content[1].type, 'text', 'the prompt travels with the image, not as a system turn');
    assert.equal(request.output_config.format.type, 'json_schema');
    assert.deepEqual(request.output_config.format.schema, PAGE_EXTRACTION_JSON_SCHEMA);
    assert.equal(request.output_config.effort, 'low');

    assert.equal(result!.extraction.rows.length, 1);
    assert.equal(result!.extraction.rows[0]!.total, '12809,41');
    assert.equal(result!.usage.inputTokens, 1100);
    // Sonnet 5 intro pricing: 1100 in + 40 out.
    assert.ok(result!.usage.costUsd > 0, 'a real call must report a real cost');
  });

  test('the batch path keys results by custom_id, not by arrival order', async () => {
    seen.length = 0;
    polls = 0;
    const provider = batchProvider();
    const results = await provider.extractPages([image(1), image(2)]);

    const submitted = seen.find((s) => s.path === '/v1/messages/batches')!.body;
    assert.deepEqual(submitted.requests.map((r: any) => r.custom_id), ['page-1', 'page-2']);
    assert.equal(submitted.requests.length, 2, 'one request per page, submitted together');

    // The server answered page 2 first. Order must survive that.
    assert.deepEqual(results.map((r) => r.page), [1, 2]);
    assert.ok(results.every((r) => r.extraction.rows.length === 1));
    assert.ok(polls > 1, 'the provider must wait for the batch to finish, not assume it did');
  });

  test('batch is billed at half of sync for the identical response', async () => {
    const sync = await new AnthropicPageExtractionProvider({ client: client(), mode: 'sync' }).extractPages([image(1)]);
    polls = 0;
    const batch = await batchProvider().extractPages([image(1)]);
    assert.equal(batch[0]!.usage.costUsd, sync[0]!.usage.costUsd / 2);
  });

  test('a page whose batch request failed produces no rows, and says so', async () => {
    // The server only answers for pages 1 and 2; page 3 comes back missing.
    polls = 0;
    const results = await batchProvider().extractPages([image(1), image(2), image(3)]);
    const missing = results.find((r) => r.page === 3)!;
    assert.equal(missing.extraction.rows.length, 0);
    assert.match(missing.extraction.unreadable[0]!, /did not succeed/);
  });

  test('the detection provider goes over the same wire with its own schema', async () => {
    seen.length = 0;
    const decision = await new AnthropicLlmProvider({ client: client(), model: 'claude-opus-5' })
      .decide({ promptId: 'p', promptVersion: 'v1', prompt: 'is this a duplicate?' });
    assert.equal(decision.decision.verdict, 'DUPLICATE');
    const request = seen.find((s) => s.path === '/v1/messages')!.body;
    assert.equal(request.output_config.format.type, 'json_schema');
    assert.ok(!JSON.stringify(request.messages).includes('"image"'), 'detection never sends a page image');
  });
});
