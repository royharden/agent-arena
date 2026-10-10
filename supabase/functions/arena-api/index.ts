import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

interface SeatDef { seat: number; name: string; kind: 'llm' | 'jev'; persona?: string }interface EventRow {
  seq: number; actor: number; type: string; payload: Record<string, unknown>;
  visible_to?: number[] | null; latency_ms?: number | null; cost_usd?: number | null;
}

// Ratings settle via pairwise Elo computed client-side per match.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return json({ error: 'server_config' }, 500);
    const db = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (req.method === 'POST' && action === 'save_match') {
      const { match, events } = await req.json() as { match: { game: string; seats: SeatDef[]; winner_seat: number | null }; events: EventRow[] };
      const { data: inserted, error } = await db.from('matches').insert({
        game: match.game,
        seats: match.seats,
        winner_seat: match.winner_seat,
        status: 'complete',
      }).select('id').single();
      if (error) return json({ error: error.message }, 500);
      const matchId = inserted.id as string;
      const rows = events.map((e) => ({
        match_id: matchId,
        seq: e.seq,
        actor: e.actor,
        type: e.type,
        payload: e.payload,
        visible_to: e.visible_to ?? null,
        latency_ms: e.latency_ms ?? null,
        cost_usd: e.cost_usd ?? null,
      }));
      if (rows.length) {
        const { error: evErr } = await db.from('events').insert(rows);
        if (evErr) return json({ error: evErr.message, match_id: matchId }, 500);
      }
      return json({ match_id: matchId });
    }

    if (req.method === 'POST' && action === 'settle') {
      const { match_id, winner_seat, bets, ratings_updates } = await req.json() as {
        match_id: string; winner_seat: number;
        bets: { id: string; won: boolean; payout: number; viewer_id: string; stake: number; refund_stake?: boolean }[];
        ratings_updates: { player_type: string; game: string; new_elo: number; games_delta: number }[];
      };

      // settle bets: viewer gets payout credited; loser stake already deducted at bet time
      for (const b of bets) {
        await db.from('bets').update({ payout: b.won ? b.payout : 0 }).eq('id', b.id);
        if (b.won) {
          const { data: v } = await db.from('viewers').select('points').eq('viewer_id', b.viewer_id).maybeSingle();
          if (v) {
            await db.from('viewers').update({ points: v.points + b.payout }).eq('viewer_id', b.viewer_id);
          }
        }
      }

      // ratings: only through the edge function
      for (const r of ratings_updates) {
        const { data: existing } = await db.from('ratings').select('elo, games').match({ player_type: r.player_type, game: r.game }).maybeSingle();
        if (existing) {
          await db.from('ratings').update({ elo: r.new_elo, games: existing.games + r.games_delta }).match({ player_type: r.player_type, game: r.game });
        } else {
          await db.from('ratings').insert({ player_type: r.player_type, game: r.game, elo: r.new_elo, games: r.games_delta });
        }
      }

      await db.from('matches').update({ status: 'complete', winner_seat }).eq('id', match_id);
      return json({ ok: true });
    }

    if (req.method === 'POST' && action === 'place_bet') {
      const { match_id, viewer_id, nickname, seat, stake } = await req.json() as {
        match_id: string; viewer_id: string; nickname: string; seat: number; stake: number;
      };
      const { data: v } = await db.from('viewers').select('points').eq('viewer_id', viewer_id).maybeSingle();
      if (!v) return json({ error: 'viewer_not_found' }, 404);
      if (v.points < stake) return json({ error: 'insufficient_points' }, 400);
      await db.from('viewers').update({ points: v.points - stake }).eq('viewer_id', viewer_id);
      const { data: bet, error } = await db.from('bets').insert({ match_id, viewer_id, nickname, seat, stake }).select('id').single();
      if (error) return json({ error: error.message }, 500);
      return json({ bet_id: bet.id });
    }

    if (req.method === 'GET' && action === 'replays') {
      const { data, error } = await db.from('matches').select('*').eq('status', 'complete').order('created_at', { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 500);
      return json({ matches: data });
    }

    if (req.method === 'GET' && action === 'leaderboard') {
      const [ratings, viewers] = await Promise.all([
        db.from('ratings').select('*').order('elo', { ascending: false }),
        db.from('viewers').select('viewer_id, nickname, points').order('points', { ascending: false }).limit(20),
      ]);
      return json({ ratings: ratings.data ?? [], viewers: viewers.data ?? [] });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
});
