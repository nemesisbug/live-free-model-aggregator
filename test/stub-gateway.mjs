// Stub gateway for local practice trials: a mock OpenRouter behind the same Chat
// Completions route the real grader gateway serves. It answers every call with a real
// OpenAI-shaped completion echoing the prompt's token, records every call in the
// scorer's cassette format (cassette.json + bodies/<sha256>), and can script failures
// to exercise the entry's failover.
//
// Env: STUB_PORT (default 18080), STUB_CASSETTE_DIR (required), STUB_SCENARIO:
//   clean    — every call succeeds.
//   failover — the first call to inkling-2-small answers 429, the first call to
//              nemotron-3.5-super-vl answers 500, everything else succeeds.
//   all429   — every call answers 429 (the entry should give up cleanly).
//
// The stub is a test double only. It never leaves this machine and holds no key.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.STUB_PORT ?? 18080);
const CASSETTE_DIR = process.env.STUB_CASSETTE_DIR ?? '';
const SCENARIO = process.env.STUB_SCENARIO ?? 'clean';
const OPENROUTER_PREFIX = 'openrouter/';
const FIXED_CREATED = 1767225600;

if (CASSETTE_DIR === '') {
  process.stderr.write('stub-gateway: STUB_CASSETTE_DIR is not set\n');
  process.exit(1);
}
mkdirSync(join(CASSETTE_DIR, 'bodies'), { recursive: true });

const entries = [];
const callsByModel = new Map();

function log(message) {
  process.stderr.write(`stub: ${message}\n`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeCassette() {
  writeFileSync(join(CASSETTE_DIR, 'cassette.json'), `${JSON.stringify({ entries })}\n`);
}

function record(entry, bodyBytes) {
  const sha = sha256(bodyBytes);
  entry.body_sha256 = sha;
  writeFileSync(join(CASSETTE_DIR, 'bodies', sha), bodyBytes);
  entries.push(entry);
  writeCassette();
}

function tokenOf(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content !== 'string') continue;
    const m = content.match(/[A-Z]{3,12}-[0-9]{4}/);
    if (m !== null) return m[0];
  }
  return null;
}

function jsonModeOf(body) {
  return body?.response_format?.type === 'json_object' || body?.response_format?.type === 'json_schema';
}

function answerText(body, token) {
  const found = token ?? 'NO-TOKEN';
  return jsonModeOf(body) ? `{"token": "${found}"}` : found;
}

function usageOf(body, answer) {
  const input = Math.max(1, Math.floor(JSON.stringify(body).length / 4));
  const output = Math.max(1, answer.split(/\s+/).length);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function scriptedFailure(model, body, previousCalls) {
  if (SCENARIO === 'all429') return { status: 429, code: 'rate_limited', type: 'rate_limit_error', message: 'rate limited by the stub' };
  if (SCENARIO !== 'failover') return null;
  const seen = previousCalls;
  if (model.endsWith('thinkingmachines/inkling-2-small:free') && seen === 0) {
    return { status: 429, code: 'rate_limited', type: 'rate_limit_error', message: 'rate limited by the stub' };
  }
  if (model.endsWith('nvidia/nemotron-3.5-super-vl:free') && seen === 0) {
    return { status: 500, code: 'server_error', type: 'server_error', message: 'upstream error from the stub' };
  }
  return null;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found', code: null } }));
    return;
  }
  const body = await readJson(req);
  if (body === null || typeof body.model !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad body', type: 'invalid_request_error', code: 'invalid_request_error' } }));
    return;
  }
  const model = body.model;
  const bare = model.startsWith(OPENROUTER_PREFIX) ? model.slice(OPENROUTER_PREFIX.length) : model;
  const seq = entries.length;
  const stream = body.stream === true;
  const previousCalls = callsByModel.get(model) ?? 0;
  callsByModel.set(model, previousCalls + 1);

  const failure = scriptedFailure(model, body, previousCalls);
  if (failure !== null) {
    const errorBody = Buffer.from(JSON.stringify({ error: { message: failure.message, type: failure.type, code: failure.code } }));
    record(
      { seq, route: 'openai.chat', outcome: 'upstream_error', model, stream, status: failure.status, usage: null, micro_usd: '0' },
      errorBody,
    );
    log(`${seq} ${model} -> ${failure.status} (${SCENARIO})`);
    res.writeHead(failure.status, { 'content-type': 'application/json' });
    res.end(errorBody);
    return;
  }

  const token = tokenOf(body);
  const answer = answerText(body, token);
  const usage = usageOf(body, answer);
  const id = `chatcmpl-stub-${seq}`;
  if (!stream) {
    const payload = { id, object: 'chat.completion', created: FIXED_CREATED, model: bare, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage };
    const bytes = Buffer.from(JSON.stringify(payload));
    record({ seq, route: 'openai.chat', outcome: 'upstream', model, stream, status: 200, usage: { input: usage.prompt_tokens, output: usage.completion_tokens }, micro_usd: '0' }, bytes);
    log(`${seq} ${model} -> 200 (token ${token})`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bytes);
    return;
  }
  const chunk1 = { id, object: 'chat.completion.chunk', created: FIXED_CREATED, model: bare, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] };
  const chunk2 = { id, object: 'chat.completion.chunk', created: FIXED_CREATED, model: bare, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage };
  const text = `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(text);
  record({ seq, route: 'openai.chat', outcome: 'upstream', model, stream, status: 200, usage: { input: usage.prompt_tokens, output: usage.completion_tokens }, micro_usd: '0' }, bytes);
  log(`${seq} ${model} -> 200 stream (token ${token})`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.end(bytes);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT} (scenario ${SCENARIO})`);
});

process.on('SIGTERM', () => {
  writeCassette();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  writeCassette();
  server.close(() => process.exit(0));
});
