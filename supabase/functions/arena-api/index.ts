import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

interface SeatDef { seat: number; name: string; kind: 'llm' | 'jev'; persona?: string }
interface EventRow {
  seq: number; actor: number; type: string; payload: Record<string, unknown>;
  visible_to?: number[] | null; latency_ms?: number | null; cost_usd?: number | null;
}

function seatToPlayerType(s: SeatDef): string {
  return s.kind === 'jev' ? 'Jev' : `LLM ${s.persona ?? ''}`.trim();
}

// Multi-player Elo scored pairwise, K = 24.
function pairwiseElo(
  elos: Record<string, number>,
  types: string[],
  winnerSeat: number,
  k = 24,
): Record<string, number> {
  const out = { ...elos };
  const n = types.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = types[i];
      const b = types[j];
      if (a === b) continue;
      const ea = 1 / (1 + Math.pow(10, ((out[b] ?? 1200) - (out[a] ?? 1200)) / 400));
      const aWon = i === winnerSeat;
      const bWon = j === winnerSeat;
      out[a] = (out[a] ?? 1200) + k * ((aWon ? 1 : 0) - ea);
      out[b] = (out[b] ?? 1200) + k * ((bWon ? 1 : 0) - (1 - ea));
    }
  }
  return out;
}

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
        status: 'in_progress',
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
      const { match_id } = await req.json() as { match_id: string };

      // Idempotency: if a 'settled' event already exists for this match, reject.
      const { data: existingSettled } = await db.from('events')
        .select('id').eq('match_id', match_id).eq('type', 'settled').limit(1);
      if (existingSettled && existingSettled.length > 0) {
        return json({ error: 'already_settled' }, 409);
      }

      // Insert the sentinel 'settled' event to mark settlement in progress.
      const { error: settleErr } = await db.from('events').insert({
        match_id,
        seq: 999999,
        actor: -1,
        type: 'settled',
        payload: {},
        visible_to: null,
      });
      if (settleErr) return json({ error: settleErr.message }, 500);

      // Load the match from DB — never trust client-sent winner/seats.
      const { data: matchRow, error: matchErr } = await db.from('matches')
        .select('game, seats, winner_seat').eq('id', match_id).maybeSingle();
      if (matchErr || !matchRow) return json({ error: 'match_not_found' }, 404);

      const seats = matchRow.seats as unknown as SeatDef[];
      const winnerSeat = matchRow.winner_seat as number | null;
      const game = matchRow.game as string;

      if (winnerSeat === null || winnerSeat < 0) {
        await db.from('matches').update({ status: 'complete' }).eq('id', match_id);
        return json({ ok: true, note: 'no winner' });
      }

      // --- Settle bets from DB (ignore client-sent bet data) ---
      const { data: betRows, error: betErr } = await db.from('bets')
        .select('id, viewer_id, seat, stake').eq('match_id', match_id).is('payout', null);
      if (betErr) return json({ error: betErr.message }, 500);

      for (const b of betRows ?? []) {
        const won = b.seat === winnerSeat;
        const payout = won ? Math.min(Math.round(b.stake * 10), b.stake * 10) : 0;
        await db.from('bets').update({ payout }).eq('id', b.id);
        if (won) {
          const { data: v } = await db.from('viewers').select('points').eq('viewer_id', b.viewer_id).maybeSingle();
          if (v) {
            await db.from('viewers').update({ points: v.points + payout }).eq('viewer_id', b.viewer_id);
          }
        }
      }

      // --- Compute Elo on the server (ignore client-sent ratings) ---
      const types = seats.map(seatToPlayerType);
      const uniqueTypes = Array.from(new Set(types));

      // Load current Elo for all involved player types.
      const currentElos: Record<string, number> = {};
      for (const t of uniqueTypes) {
        const { data: r } = await db.from('ratings').select('elo, games')
          .match({ player_type: t, game }).maybeSingle();
        currentElos[t] = r ? Number(r.elo) : 1200;
      }

      const newElos = pairwiseElo(currentElos, types, winnerSeat);

      // Persist updated ratings (games + 1 per seat).
      const gamesDelta: Record<string, number> = {};
      for (const t of types) gamesDelta[t] = (gamesDelta[t] ?? 0) + 1;

      for (const t of uniqueTypes) {
        const { data: existing } = await db.from('ratings').select('elo, games')
          .match({ player_type: t, game }).maybeSingle();
        if (existing) {
          await db.from('ratings').update({
            elo: newElos[t],
            games: existing.games + (gamesDelta[t] ?? 0),
          }).match({ player_type: t, game });
        } else {
          await db.from('ratings').insert({
            player_type: t,
            game,
            elo: newElos[t],
            games: gamesDelta[t] ?? 0,
          });
        }
      }

      await db.from('matches').update({ status: 'complete' }).eq('id', match_id);
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
