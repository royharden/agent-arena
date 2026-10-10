const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000; // USD; output tokens free
const PINNED_MODEL = 'jev-1.13.0';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function callTypesafe(apiKey: string, payload: unknown): Promise<{ res?: Record<string, unknown>; err?: string; status?: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 429 || r.status === 529) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
        return { err: `rate_limited_${r.status}`, status: r.status };
      }
      if (!r.ok) {
        const text = await r.text();
        return { err: `upstream_${r.status}`, status: r.status, res: { detail: text.slice(0, 400) } };
      }
      return { res: await r.json() };
    } catch (e) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        continue;
      }
      return { err: e instanceof Error ? e.message : 'network_error' };
    }
  }
  return { err: 'exhausted_retries' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  const started = Date.now();
  try {
    const apiKey = Deno.env.get('TYPESAFE_API_KEY');
    if (!apiKey) return json({ error: 'no_typesafe_key' }, 503);
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceRoleKey || !supabaseUrl) return json({ error: 'server_config' }, 500);

    // Atomically increment the daily counter and check the cap before calling
    // TypeSafe. If the cap is reached, increment_usage returns NULL.
    const capRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_usage`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_fn: 'jev', p_cap: 200 }),
    });
    if (!capRes.ok) return json({ error: 'counter_error' }, 500);
    const capData = await capRes.json();
    if (capData !== true) return json({ error: 'daily_cap' }, 429);

    const body = await req.json();
    const { state, questions } = body as {
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    };

    const payload = {
      model: PINNED_MODEL,
      state,
      questions,
    };
    const { res, err, status } = await callTypesafe(apiKey, payload);
    if (err || !res) {
      return json({ error: err ?? 'unknown_upstream', upstream_status: status }, 502);
    }

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
    return json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
});
