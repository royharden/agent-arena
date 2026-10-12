import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000; // USD; output tokens free
const PINNED_MODEL = 'jev-1.13.0';
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const FN_NAME = 'jev';
const DEFAULT_DAILY_CALL_LIMIT = 200;
const MAX_ATTEMPTS = 2;
const UPSTREAM_TIMEOUT_MS = 25_000;

// ---- Request limits ----
const MAX_BODY_BYTES = 32 * 1024;
const MAX_QUESTIONS = 20;
const MAX_CRITERIA = 12;
const MAX_KEY_CHARS = 64;
const MAX_INSTRUCTIONS_CHARS = 500;
const MAX_CRITERION_CHARS = 200;
const MAX_QUESTION_TYPE_CHARS = 32;
const STATE_LIMITS = { maxDepth: 5, maxNodes: 1000, maxArray: 50, maxKeys: 30, maxString: 500 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Thrown for client errors; turned into a JSON response by the top-level catch.
class Reject extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Reads the body with a hard byte cap (413) before parsing (400 on bad JSON).
async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Reject(413, 'payload_too_large');
  if (!req.body) throw new Reject(400, 'invalid_json');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Reject(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new Reject(400, 'invalid_json');
  }
  if (!isPlainObject(parsed)) throw new Reject(400, 'invalid_json');
  return parsed;
}

// Bounds an arbitrary JSON value: nesting depth, node count, array/object
// sizes and string length. Throws 422 when any limit is exceeded.
function assertBoundedJson(value: unknown, limits: typeof STATE_LIMITS) {
  let nodes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new Reject(422, 'state_too_large');
    if (typeof v === 'string') {
      if (v.length > limits.maxString) throw new Reject(422, 'field_too_long');
    } else if (Array.isArray(v)) {
      if (v.length > limits.maxArray) throw new Reject(422, 'too_many_items');
      for (const x of v) walk(x, depth + 1);
    } else if (isPlainObject(v)) {
      const keys = Object.keys(v);
      if (keys.length > limits.maxKeys) throw new Reject(422, 'too_many_items');
      for (const k of keys) {
        if (k.length > MAX_KEY_CHARS) throw new Reject(422, 'field_too_long');
        walk(v[k], depth + 1);
      }
    } else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Reject(400, 'invalid_state');
    }
  };
  walk(value, 0);
}

// Whitelists question fields (type, instructions, criteria) and bounds them.
function sanitizeQuestions(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Reject(400, 'invalid_questions');
  const ids = Object.keys(raw);
  if (ids.length === 0) throw new Reject(400, 'invalid_questions');
  if (ids.length > MAX_QUESTIONS) throw new Reject(422, 'too_many_questions');
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    if (id.length > MAX_KEY_CHARS) throw new Reject(422, 'field_too_long');
    const q = raw[id];
    if (!isPlainObject(q)) throw new Reject(400, 'invalid_questions');
    if (typeof q.type !== 'string' || q.type.length < 1 || q.type.length > MAX_QUESTION_TYPE_CHARS) throw new Reject(400, 'invalid_questions');
    if (typeof q.instructions !== 'string') throw new Reject(400, 'invalid_questions');
    if (q.instructions.length > MAX_INSTRUCTIONS_CHARS) throw new Reject(422, 'field_too_long');
    const clean: Record<string, unknown> = { type: q.type, instructions: q.instructions };
    if (q.criteria !== undefined) {
      if (!isPlainObject(q.criteria)) throw new Reject(400, 'invalid_questions');
      const entries = Object.entries(q.criteria);
      if (entries.length > MAX_CRITERIA) throw new Reject(422, 'too_many_criteria');
      for (const [k, v] of entries) {
        if (k.length > MAX_KEY_CHARS) throw new Reject(422, 'field_too_long');
        if (typeof v !== 'string') throw new Reject(400, 'invalid_questions');
        if (v.length > MAX_CRITERION_CHARS) throw new Reject(422, 'field_too_long');
      }
      clean.criteria = q.criteria;
    }
    out[id] = clean;
  }
  return out;
}

function dailyCallLimit(): number {
  const n = Number(Deno.env.get('DAILY_CALL_LIMIT'));
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CALL_LIMIT;
}

type UsageResult = 'ok' | 'over_limit' | 'unavailable';

// Atomically counts one paid upstream call. Fails closed: an RPC error, a
// missing result or a non-integer result never counts as "ok".
async function countUpstreamCall(db: SupabaseClient): Promise<UsageResult> {
  try {
    const { data, error } = await db.rpc('increment_usage_counter', { p_fn: FN_NAME });
    if (error) {
      console.error('[jev] usage counter rpc error', error);
      return 'unavailable';
    }
    if (typeof data !== 'number' || !Number.isInteger(data)) {
      console.error('[jev] usage counter returned non-integer', data);
      return 'unavailable';
    }
    return data <= dailyCallLimit() ? 'ok' : 'over_limit';
  } catch (e) {
    console.error('[jev] usage counter threw', e);
    return 'unavailable';
  }
}

type UpstreamResult =
  | { ok: true; res: Record<string, unknown> }
  | { ok: false; usage: Exclude<UsageResult, 'ok'> }
  | { ok: false; error: string; status?: number };

const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));

async function callTypesafe(db: SupabaseClient, apiKey: string, payload: unknown): Promise<UpstreamResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Count every paid attempt (retries included) right before the fetch.
    // Never retry once the daily limit is hit.
    const usage = await countUpstreamCall(db);
    if (usage !== 'ok') return { ok: false, usage };

    let r: Response;
    try {
      r = await fetch(TYPESAFE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      console.error(`[jev] network error (attempt ${attempt})`, e);
      if (attempt < MAX_ATTEMPTS) { await backoff(attempt); continue; }
      return { ok: false, error: 'network_error' };
    }
    if (r.status === 429 || r.status === 529) {
      await r.body?.cancel();
      if (attempt < MAX_ATTEMPTS) { await backoff(attempt); continue; }
      return { ok: false, error: 'rate_limited', status: r.status };
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[jev] upstream ${r.status}`, text.slice(0, 1000));
      return { ok: false, error: 'upstream_error', status: r.status };
    }
    try {
      const res = await r.json();
      if (!isPlainObject(res)) throw new Error('non-object response');
      return { ok: true, res };
    } catch (e) {
      console.error('[jev] unparseable upstream response', e);
      return { ok: false, error: 'upstream_error', status: r.status };
    }
  }
  return { ok: false, error: 'exhausted_retries' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  const started = Date.now();
  try {
    const apiKey = Deno.env.get('TYPESAFE_API_KEY');
    if (!apiKey) return json({ error: 'no_typesafe_key' }, 503);
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceRoleKey || !supabaseUrl) return json({ error: 'server_config' }, 503);
    const db = createClient(supabaseUrl, serviceRoleKey);

    // Validate and bound the request before any paid call.
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!isPlainObject(body.state)) throw new Reject(400, 'invalid_state');
    assertBoundedJson(body.state, STATE_LIMITS);
    const state = body.state;
    const questions = sanitizeQuestions(body.questions);

    const payload = {
      model: PINNED_MODEL,
      state,
      questions,
    };
    const result = await callTypesafe(db, apiKey, payload);
    if (!result.ok) {
      if ('usage' in result) {
        return json({ error: 'daily_limit' }, result.usage === 'over_limit' ? 429 : 503);
      }
      return json({ error: result.error, upstream_status: result.status }, 502);
    }
    const res = result.res;

    const usage = (res.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const latencyMs = Date.now() - started;
    const costUsd = inputTokens * COST_PER_INPUT_TOKEN;
    const responseModel = String(res.model ?? PINNED_MODEL);

    return json({
      answers: res.answers ?? res.choices ?? null,
      model: responseModel,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latency_ms: latencyMs,
      cost_usd: costUsd,
    });
  } catch (err) {
    if (err instanceof Reject) return json({ error: err.code }, err.status);
    console.error('[jev] unhandled', err);
    return json({ error: 'internal_error' }, 500);
  }
});
