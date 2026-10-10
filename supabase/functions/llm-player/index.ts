const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const DAILY_CAP = 200;

async function checkCap(fn: string, serviceRoleKey: string, supabaseUrl: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${supabaseUrl}/rest/v1/usage_counters?day=eq.${day}&fn=eq.${fn}&select=calls`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok) return true; // fail open on counter read errors
  const rows = await res.json();
  return (rows[0]?.calls ?? 0) < DAILY_CAP;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    if (!serviceRoleKey || !supabaseUrl) return json({ error: 'server_config' }, 500);

    if (!(await checkCap('llm-player', serviceRoleKey, supabaseUrl))) {
      return json({ error: 'daily_cap' }, 429);
    }

    const body = await req.json();
    const { game, persona, visible_state, legal_moves } = body as {
      game: string; persona: string; visible_state: Record<string, unknown>; legal_moves: unknown[];
    };

    const system = `You are ${persona}, an AI playing ${game}. Think in character: Cautious plays safe, Bluffer bluffs and misleads, Analyst computes odds, Chaos acts randomly but never admits it. Respond ONLY with JSON: {"move": <one element of legal_moves>, "table_talk": "<= 140 chars of in-character table talk", "private_reasoning": "<= 200 chars of private thinking"}. "move" must be copied exactly from the legal_moves list.`;

    const completion = await fetch(`${baseUrl}/chat/completions`, {
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
    });
    if (!completion.ok) {
      const text = await completion.text();
      return json({ error: 'upstream_error', status: completion.status, detail: text.slice(0, 400) }, 502);
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

    // increment counter (fire and forget)
    {
      const day = new Date().toISOString().slice(0, 10);
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/`, { method: 'POST' });
      void rpcRes;
      // upsert increment via PostgREST is not atomic; use a simple update + insert
      const read = await fetch(`${supabaseUrl}/rest/v1/usage_counters?day=eq.${day}&fn=eq.llm-player&select=calls`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      });
      const rows = await read.json().catch(() => [] as { calls: number }[]);
      const current = rows[0]?.calls ?? 0;
      const method = rows.length ? 'PATCH' : 'POST';
      await fetch(
        rows.length
          ? `${supabaseUrl}/rest/v1/usage_counters?day=eq.${day}&fn=eq.llm-player`
          : `${supabaseUrl}/rest/v1/usage_counters`,
        {
          method,
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(rows.length ? { calls: current + 1 } : { day, fn: 'llm-player', calls: 1 }),
        },
      );
    }

    return json({ move: parsed.move, table_talk: tableTalk, private_reasoning: privateReasoning, model });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
});
