const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

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

    // Atomically increment the daily counter and check the cap before making
    // the upstream call. If the cap is reached, increment_usage returns no
    // row (NULL), which we treat as "cap reached".
    const capRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_usage`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_fn: 'llm-player', p_cap: 200 }),
    });
    if (!capRes.ok) return json({ error: 'counter_error' }, 500);
    const capData = await capRes.json();
    if (capData !== true) return json({ error: 'daily_cap' }, 429);

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

    return json({ move: parsed.move, table_talk: tableTalk, private_reasoning: privateReasoning, model });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
});
