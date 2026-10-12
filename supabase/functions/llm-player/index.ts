import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const FN_NAME = 'llm-player';
const DEFAULT_DAILY_CALL_LIMIT = 200;
const UPSTREAM_TIMEOUT_MS = 25_000;

// ---- Request limits ----
const MAX_BODY_BYTES = 32 * 1024;
const MAX_LEGAL_MOVES = 150;
const MAX_KEY_CHARS = 64;
const STATE_LIMITS = { maxDepth: 5, maxNodes: 1000, maxArray: 50, maxKeys: 30, maxString: 500 };
const MOVE_LIMITS = { maxDepth: 2, maxNodes: 20, maxArray: 10, maxKeys: 10, maxString: 100 };

const GAMES = ['liars_dice', 'werewolf'];
const PERSONAS = ['Cautious', 'Bluffer', 'Analyst', 'Chaos'];

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
      console.error('[llm-player] usage counter rpc error', error);
      return 'unavailable';
    }
    if (typeof data !== 'number' || !Number.isInteger(data)) {
      console.error('[llm-player] usage counter returned non-integer', data);
      return 'unavailable';
    }
    return data <= dailyCallLimit() ? 'ok' : 'over_limit';
  } catch (e) {
    console.error('[llm-player] usage counter threw', e);
    return 'unavailable';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) return json({ error: 'no_openai_key' }, 503);
    const baseUrl = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
    const model = Deno.env.get('OPENAI_MODEL') ?? 'gpt-6-luna';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceRoleKey || !supabaseUrl) return json({ error: 'server_config' }, 503);
    const db = createClient(supabaseUrl, serviceRoleKey);

    // Validate and bound the request before building the prompt or calling out.
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const { game, persona, visible_state, legal_moves } = body;
    // game and persona are interpolated into the system prompt: whitelist them.
    if (typeof game !== 'string' || !GAMES.includes(game)) throw new Reject(400, 'invalid_game');
    if (typeof persona !== 'string' || !PERSONAS.includes(persona)) throw new Reject(400, 'invalid_persona');
    if (!isPlainObject(visible_state)) throw new Reject(400, 'invalid_state');
    assertBoundedJson(visible_state, STATE_LIMITS);
    if (!Array.isArray(legal_moves) || legal_moves.length === 0) throw new Reject(400, 'invalid_legal_moves');
    if (legal_moves.length > MAX_LEGAL_MOVES) throw new Reject(422, 'too_many_legal_moves');
    for (const m of legal_moves) assertBoundedJson(m, MOVE_LIMITS);

    const system = `You are ${persona}, an AI playing ${game}. Think in character: Cautious plays safe, Bluffer bluffs and misleads, Analyst computes odds, Chaos acts randomly but never admits it. Respond ONLY with JSON: {"move": <one element of legal_moves>, "table_talk": "<= 140 chars of in-character table talk", "private_reasoning": "<= 200 chars of private thinking"}. "move" must be copied exactly from the legal_moves list.`;

    // Count this paid call right before the fetch; fail closed.
    const usage = await countUpstreamCall(db);
    if (usage !== 'ok') return json({ error: 'daily_limit' }, usage === 'over_limit' ? 429 : 503);

    let completion: Response;
    try {
      completion = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ visible_state, legal_moves }) },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      console.error('[llm-player] network error', e);
      return json({ error: 'network_error' }, 502);
    }
    if (!completion.ok) {
      const text = await completion.text().catch(() => '');
      console.error(`[llm-player] upstream ${completion.status}`, text.slice(0, 1000));
      return json({ error: 'upstream_error', status: completion.status }, 502);
    }
    const data = await completion.json();
    let parsed: { move?: unknown; table_talk?: unknown; private_reasoning?: unknown };
    try {
      parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    } catch {
      return json({ error: 'unparseable_move' }, 502);
    }
    const isLegal = legal_moves.some((m) => JSON.stringify(m) === JSON.stringify(parsed.move));
    if (!isLegal) return json({ error: 'illegal_move', move: parsed.move ?? null }, 400);

    const tableTalk = String(parsed.table_talk ?? '').slice(0, 140);
    const privateReasoning = String(parsed.private_reasoning ?? '').slice(0, 200);

    return json({ move: parsed.move, table_talk: tableTalk, private_reasoning: privateReasoning, model });
  } catch (err) {
    if (err instanceof Reject) return json({ error: err.code }, err.status);
    console.error('[llm-player] unhandled', err);
    return json({ error: 'internal_error' }, 500);
  }
});
