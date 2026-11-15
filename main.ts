// free-model-aggregator-02: one server, two client wires, and a real free model behind
// every answer.
//
// The entry is an aggregator: a client points at it, and every completion it answers comes
// from a live free OpenRouter model dialled through the grader's gateway on the entrant's
// pushed key. It serves the OpenAI Chat Completions API and the Anthropic Messages API, in
// JSON and in server-sent events.
//
// Routing, in one line: rank every free model that meets the prompt's requirements by the
// brief's rating_milli, minus a penalty per refusal from that model, so a model that just
// said no is tried last. When two candidates tie on that score, the one called fewer times
// in this trial goes first: the trial spreads its calls across the free models instead of
// hammering the single best one into a 429, and a model that has already answered keeps its
// place in line behind one that has not. The best candidate serves every prompt it can: there
// is no sealed per-model budget to save for, only OpenRouter's real limits (20 free requests a minute,
// 50 a day under 10 purchased credits, 1,000 a day at 10 or more), and the trial holds six
// prompts. A refusal is handled by its kind: a 429 rate limit fails over at once to the
// next best (it will not clear inside the prompt's 30 seconds), a 5xx or a broken call is
// retried once on the same model (transient), and a 401 gives up (every model would refuse
// the same way: no key was pushed). Every refusal a prompt survived is reported in the
// `x-makefun-upstream-failures` header, the only way the failover column can see it.
//
// Deterministic: every choice is a function of the brief, the requests and the gateway's
// answers. No clock, no unseeded randomness, fixed ids and timestamps in every rendered
// answer, so a replay leaves the same state export.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How long one gateway call may take before it counts as refused, in milliseconds. */
const CALL_TIMEOUT_MS = 15000;
/** The most gateway calls one prompt may cost (the trial's cap is 60; six prompts). */
const MAX_GATEWAY_CALLS_PER_PROMPT = 4;
/** The output cap a gateway body gets when the client named none (the gateway refuses uncapped). */
const DEFAULT_MAX_TOKENS = 1024;
/** Rating points lost per refusal from a model (tries it last for later prompts). */
const FAIL_PENALTY = 10;
/** The most refusal rows the trail header may carry. */
const MAX_TRAIL_ROWS = 8;
/** The most bytes of a refusal body read to find its error code. */
const MAX_REFUSAL_TEXT = 2000;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Refusals from each model so far, by dialled id. */
const failuresByModel = new Map<string, number>();

/** Gateway attempts per model so far in this trial, by dialled id. */
const callsByModel = new Map<string, number>();

/**
 * How many times this model has been dialled so far in this trial. The count is the
 * load-balancing tie-break in candidatesFor: a model called fewer times goes first.
 */
function callsOf(modelId: string): number {
  return callsByModel.get(modelId) ?? 0;
}

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function failuresOf(modelId: string): number {
  return failuresByModel.get(modelId) ?? 0;
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

interface Candidate {
  model: ModelRow;
  rating: number;
  score: number;
  calls: number;
}

/**
 * Every free model that can serve these requirements, best first: the brief's rating, minus a
 * penalty per refusal from that model. Ties break first on the rating, then on how many times
 * the model has already been called in this trial — the less-called model goes first, so a
 * trial spreads its calls instead of hammering one free model into a 429 — and last on the id.
 * The order stays a pure function of the brief and the gateway's answers so far: no clock, no
 * randomness, so a replay of the trial's cassette takes the same decisions.
 */
function candidatesFor(requires: Requirement): Candidate[] {
  const out: Candidate[] = [];
  for (const model of freeModels(brief)) {
    if (!meetsRequirements(requires, capabilitiesOf(model))) continue;
    const rating = model.rating_milli;
    out.push({ model, rating, score: rating - FAIL_PENALTY * failuresOf(model.id), calls: callsOf(model.id) });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (a.calls !== b.calls) return a.calls - b.calls;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
  return out;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** One refusal the trail header reports: the gateway's status, its error code, the model it refused. */
interface TrailRow {
  status: number;
  code: string;
  model: string | null;
}

/** The error code a refusal body names, or the status's own name when it names none. */
function errorCodeOf(text: string, status: number): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code;
      if (typeof value.error.type === 'string' && value.error.type !== '') return value.error.type;
    }
  } catch {
    // Not JSON: fall through to the status's name.
  }
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'invalid_request_error';
  if (status >= 500) return 'server_error';
  return 'upstream_error';
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  // Every gateway attempt counts, answered or refused: the count is the load-balancing
  // tie-break, and it is read before the call so the model being dialled counts too.
  callsByModel.set(model, callsOf(model) + 1);
  const upstream: Json = { ...body, model };
  if (typeof upstream.max_tokens !== 'number' && typeof upstream.max_completion_tokens !== 'number') {
    upstream.max_tokens = DEFAULT_MAX_TOKENS;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(upstream),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

type Attempt =
  | { kind: 'ok-json'; answer: Json }
  | { kind: 'ok-stream'; frames: string[] }
  | { kind: 'refused'; status: number; code: string };

/**
 * One gateway call for one candidate. A stream is collected whole before it is rendered, so a
 * stream that breaks halfway is a refusal this prompt can fail over from, not a half answer.
 */
async function attempt(candidate: Candidate, clientApi: 'openai' | 'anthropic', body: Json, stream: boolean): Promise<Attempt> {
  const model = candidate.model.id;
  let upstream: Response;
  try {
    upstream = await dial(model, clientApi === 'anthropic' ? anthropicToOpenAI(body, model) : { ...body, model });
  } catch (err) {
    const code = (err as Error).name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unreachable';
    return { kind: 'refused', status: 502, code };
  }
  if (!upstream.ok || upstream.body === null) {
    let text = '';
    try {
      text = (await upstream.text()).slice(0, MAX_REFUSAL_TEXT);
    } catch {
      // The body is unreadable: the refusal stands either way.
    }
    return { kind: 'refused', status: upstream.status, code: errorCodeOf(text, upstream.status) };
  }
  if (!stream) {
    let answer: unknown;
    try {
      answer = await upstream.json();
    } catch {
      return { kind: 'refused', status: 502, code: 'upstream_bad_json' };
    }
    return { kind: 'ok-json', answer: isRecord(answer) ? answer : {} };
  }
  const frames: string[] = [];
  try {
    if (clientApi === 'anthropic') {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, model)) frames.push(event);
    } else {
      for await (const frame of openAIStreamWithModel(upstream.body, model)) frames.push(frame);
    }
  } catch {
    return { kind: 'refused', status: 502, code: 'upstream_interrupted' };
  }
  return { kind: 'ok-stream', frames };
}

/** The trail header for a response that survived refusals, or no header when there were none. */
function trailHeaders(trail: TrailRow[]): Record<string, string> {
  if (trail.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(trail.slice(0, MAX_TRAIL_ROWS)) };
}

/**
 * Serve one client request: try the candidates best first, failing over on every refusal. A 429
 * fails over at once (a rate limit does not clear inside the prompt's 30 seconds); a 5xx or a
 * broken call is retried once on the same model; a 401 gives up, since every model would refuse
 * the same way. At most MAX_GATEWAY_CALLS_PER_PROMPT gateway calls are spent on one prompt.
 */
async function serve(res: ServerResponse, clientApi: 'openai' | 'anthropic', body: Json): Promise<void> {
  const stream = body.stream === true;
  const requires = requirementsFor(body);
  const candidates = candidatesFor(requires);
  if (candidates.length === 0) {
    const type = clientApi === 'anthropic' ? 'overloaded_error' : 'no_free_model';
    return sendError(res, clientApi, 503, type, 'no free model in the brief meets this request');
  }
  const trail: TrailRow[] = [];
  let calls = 0;
  for (const candidate of candidates) {
    if (calls >= MAX_GATEWAY_CALLS_PER_PROMPT) break;
    let result = await attempt(candidate, clientApi, body, stream);
    calls += 1;
    if (result.kind === 'refused') {
      trail.push({ status: result.status, code: result.code, model: candidate.model.id });
      failuresByModel.set(candidate.model.id, failuresOf(candidate.model.id) + 1);
      if (result.status === 401) break;
      const retryable = result.status >= 500;
      if (retryable && calls < MAX_GATEWAY_CALLS_PER_PROMPT) {
        result = await attempt(candidate, clientApi, body, stream);
        calls += 1;
        if (result.kind === 'refused') {
          trail.push({ status: result.status, code: result.code, model: candidate.model.id });
          failuresByModel.set(candidate.model.id, failuresOf(candidate.model.id) + 1);
          if (result.status === 401) break;
        }
      }
    }
    if (result.kind === 'ok-json') {
      const extra = trailHeaders(trail);
      if (clientApi === 'anthropic') sendJson(res, 200, openAIToAnthropic(result.answer, candidate.model.id), extra);
      else sendJson(res, 200, openAIJsonWithModel(result.answer, candidate.model.id), extra);
      return;
    }
    if (result.kind === 'ok-stream') {
      const extra = trailHeaders(trail);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
      for (const frame of result.frames) res.write(frame);
      res.end();
      return;
    }
  }
  const type = clientApi === 'anthropic' ? 'overloaded_error' : 'no_free_model';
  return sendError(res, clientApi, 503, type, 'every free model that meets this request refused it');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve(res, 'openai', body);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve(res, 'anthropic', body);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
