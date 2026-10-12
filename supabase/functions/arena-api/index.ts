import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ---- Request limits ----
const MAX_MATCH_BODY_BYTES = 512 * 1024; // save_match / update_match (carry event logs)
const MAX_SMALL_BODY_BYTES = 8 * 1024; // place_bet / settle
const MAX_EVENTS = 1000;
const MAX_EVENT_PAYLOAD_CHARS = 16 * 1024;
const MIN_SEATS = 2;
const MAX_SEATS = 5;
const MAX_NAME_CHARS = 40;
const MAX_NICKNAME_CHARS = 64;
const MAX_STAKE = 100_000_000; // stake * 10 payout must stay within int4
const MAX_LATENCY_MS = 10 * 60 * 1000;
const MAX_COST_USD = 100;
// update_match refuses to record a result on a match younger than this, so a
// bet can't be placed and the winner declared in the same instant.
const MIN_MATCH_AGE_MS = 15_000;

const GAMES = ['liars_dice', 'werewolf'];
const PERSONAS = ['Cautious', 'Bluffer', 'Analyst', 'Chaos'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_TYPE_RE = /^[a-z_]{1,40}$/;

interface SeatDef { seat: number; name: string; kind: 'llm' | 'jev'; persona?: string }
interface EventInsert {
  match_id: string; seq: number; actor: number; type: string; payload: Record<string, unknown>;
  visible_to: number[] | null; latency_ms: number | null; cost_usd: number | null;
}

// Thrown for client errors; turned into a JSON response by the top-level catch.
class Reject extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIntIn(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

function requireUuid(v: unknown, code: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Reject(400, code);
  return v;
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

function sanitizeSeats(raw: unknown): SeatDef[] {
  if (!Array.isArray(raw) || raw.length < MIN_SEATS || raw.length > MAX_SEATS) throw new Reject(400, 'invalid_seats');
  return raw.map((s, i) => {
    if (!isPlainObject(s) || s.seat !== i) throw new Reject(400, 'invalid_seats');
    if (typeof s.name !== 'string' || s.name.length < 1 || s.name.length > MAX_NAME_CHARS) throw new Reject(400, 'invalid_seats');
    if (s.kind !== 'llm' && s.kind !== 'jev') throw new Reject(400, 'invalid_seats');
    const seat: SeatDef = { seat: i, name: s.name, kind: s.kind };
    if (s.persona !== undefined && s.persona !== null) {
      if (typeof s.persona !== 'string' || !PERSONAS.includes(s.persona)) throw new Reject(400, 'invalid_seats');
      seat.persona = s.persona;
    }
    return seat;
  });
}

// Whitelists event columns and bounds every field before it reaches the DB.
function sanitizeEvents(raw: unknown, matchId: string, seatCount: number): EventInsert[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Reject(400, 'invalid_events');
  if (raw.length > MAX_EVENTS) throw new Reject(422, 'too_many_events');
  return raw.map((e) => {
    if (!isPlainObject(e)) throw new Reject(400, 'invalid_events');
    if (!isIntIn(e.seq, 0, MAX_EVENTS - 1)) throw new Reject(400, 'invalid_events');
    if (!isIntIn(e.actor, -1, seatCount - 1)) throw new Reject(400, 'invalid_events');
    // 'settled' is the server-only settlement sentinel.
    if (typeof e.type !== 'string' || !EVENT_TYPE_RE.test(e.type) || e.type === 'settled') throw new Reject(400, 'invalid_events');
    if (!isPlainObject(e.payload)) throw new Reject(400, 'invalid_events');
    if (JSON.stringify(e.payload).length > MAX_EVENT_PAYLOAD_CHARS) throw new Reject(422, 'event_payload_too_large');

    let visibleTo: number[] | null = null;
    if (e.visible_to !== undefined && e.visible_to !== null) {
      if (!Array.isArray(e.visible_to) || e.visible_to.length > seatCount) throw new Reject(400, 'invalid_events');
      if (!e.visible_to.every((v) => isIntIn(v, 0, seatCount - 1))) throw new Reject(400, 'invalid_events');
      visibleTo = e.visible_to as number[];
    }

    let latencyMs: number | null = null;
    if (e.latency_ms !== undefined && e.latency_ms !== null) {
      if (typeof e.latency_ms !== 'number' || !Number.isFinite(e.latency_ms) || e.latency_ms < 0 || e.latency_ms > MAX_LATENCY_MS) {
        throw new Reject(400, 'invalid_events');
      }
      latencyMs = Math.round(e.latency_ms);
    }

    let costUsd: number | null = null;
    if (e.cost_usd !== undefined && e.cost_usd !== null) {
      if (typeof e.cost_usd !== 'number' || !Number.isFinite(e.cost_usd) || e.cost_usd < 0 || e.cost_usd > MAX_COST_USD) {
        throw new Reject(400, 'invalid_events');
      }
      costUsd = e.cost_usd;
    }

    return {
      match_id: matchId,
      seq: e.seq,
      actor: e.actor,
      type: e.type,
      payload: e.payload,
      visible_to: visibleTo,
      latency_ms: latencyMs,
      cost_usd: costUsd,
    };
  });
}

function seatCountOf(seats: unknown): number {
  return Array.isArray(seats) ? seats.length : 0;
}

// Log the real DB/upstream error server side; the client only gets a code.
function dbError(context: string, err: unknown, extra: Record<string, unknown> = {}) {
  console.error(`[arena-api] ${context}`, err);
  return json({ error: 'db_error', ...extra }, 500);
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
    if (!supabaseUrl || !serviceKey) return json({ error: 'server_config' }, 503);
    const db = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    // ---- save_match: create a new in-progress match (for pre-game bet shell) ----
    if (req.method === 'POST' && action === 'save_match') {
      const body = await readJsonBody(req, MAX_MATCH_BODY_BYTES);
      const match = body.match;
      if (!isPlainObject(match)) throw new Reject(400, 'invalid_match');
      if (typeof match.game !== 'string' || !GAMES.includes(match.game)) throw new Reject(400, 'invalid_game');
      const seats = sanitizeSeats(match.seats);
      // -1 / -2 are werewolf team outcomes (no single winning seat).
      const winnerSeat = match.winner_seat ?? null;
      if (winnerSeat !== null && !isIntIn(winnerSeat, -2, seats.length - 1)) throw new Reject(400, 'invalid_winner_seat');
      // Validate events before writing anything.
      const pending = sanitizeEvents(body.events, '', seats.length);

      const { data: inserted, error } = await db.from('matches').insert({
        game: match.game,
        seats,
        winner_seat: winnerSeat,
        status: 'in_progress',
      }).select('id').single();
      if (error || !inserted) return dbError('save_match insert', error);
      const matchId = inserted.id as string;
      const rows = pending.map((r) => ({ ...r, match_id: matchId }));
      if (rows.length) {
        const { error: evErr } = await db.from('events').insert(rows);
        if (evErr) return dbError('save_match events', evErr, { match_id: matchId });
      }
      return json({ match_id: matchId });
    }

    // ---- update_match: record results on an existing match row (the one bets were placed on) ----
    if (req.method === 'POST' && action === 'update_match') {
      const body = await readJsonBody(req, MAX_MATCH_BODY_BYTES);
      const matchId = requireUuid(body.match_id, 'invalid_match_id');

      const { data: matchRow, error: matchErr } = await db.from('matches')
        .select('id, seats, status, winner_seat, created_at').eq('id', matchId).maybeSingle();
      if (matchErr) return dbError('update_match load', matchErr);
      if (!matchRow) return json({ error: 'match_not_found' }, 404);

      const seatCount = seatCountOf(matchRow.seats);
      const winnerSeat = body.winner_seat ?? null;
      if (winnerSeat !== null && !isIntIn(winnerSeat, 0, seatCount - 1)) {
        return json({ error: 'invalid_winner_seat' }, 400);
      }
      const rows = sanitizeEvents(body.events, matchId, seatCount);

      if (matchRow.status !== 'in_progress' || matchRow.winner_seat !== null) {
        return json({ error: 'match_already_finished' }, 409);
      }

      const { data: settledRows, error: settledErr } = await db.from('events')
        .select('id').eq('match_id', matchId).eq('type', 'settled').limit(1);
      if (settledErr) return dbError('update_match settled check', settledErr);
      if (settledRows && settledRows.length > 0) return json({ error: 'match_already_settled' }, 409);

      const createdAt = Date.parse(String(matchRow.created_at));
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < MIN_MATCH_AGE_MS) {
        return json({ error: 'too_early' }, 409);
      }

      // Conditional update: only an unfinished match with no winner can change,
      // so a result can't be rewritten and concurrent calls can't both win.
      const { data: updated, error: updErr } = await db.from('matches')
        .update({ winner_seat: winnerSeat, status: 'complete' })
        .eq('id', matchId)
        .eq('status', 'in_progress')
        .is('winner_seat', null)
        .select('id');
      if (updErr) return dbError('update_match update', updErr);
      if (!updated || updated.length === 0) return json({ error: 'match_already_finished' }, 409);

      if (rows.length) {
        const { error: evErr } = await db.from('events').insert(rows);
        if (evErr) return dbError('update_match events', evErr, { match_id: matchId });
      }
      return json({ match_id: matchId });
    }

    // ---- settle: idempotent, server-side bet payout + Elo ----
    if (req.method === 'POST' && action === 'settle') {
      const body = await readJsonBody(req, MAX_SMALL_BODY_BYTES);
      const match_id = requireUuid(body.match_id, 'invalid_match_id');

      // Insert the sentinel 'settled' event. The unique partial index
      // events_one_settled guarantees only one can exist per match — if a
      // concurrent settle already inserted one, this fails with 23505.
      const { error: settleErr } = await db.from('events').insert({
        match_id,
        seq: 999999,
        actor: -1,
        type: 'settled',
        payload: {},
        visible_to: null,
      });
      if (settleErr) {
        if (settleErr.code === '23505') return json({ error: 'already_settled' }, 409);
        if (settleErr.code === '23503') return json({ error: 'match_not_found' }, 404);
        return dbError('settle sentinel', settleErr);
      }

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

      // --- Settle bets from DB ---
      const { data: betRows, error: betErr } = await db.from('bets')
        .select('id, viewer_id, seat, stake').eq('match_id', match_id).is('payout', null);
      if (betErr) return dbError('settle bets', betErr);

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

      // --- Compute Elo on the server ---
      const types = seats.map(seatToPlayerType);
      const uniqueTypes = Array.from(new Set(types));

      const currentElos: Record<string, number> = {};
      for (const t of uniqueTypes) {
        const { data: r } = await db.from('ratings').select('elo, games')
          .match({ player_type: t, game }).maybeSingle();
        currentElos[t] = r ? Number(r.elo) : 1200;
      }

      const newElos = pairwiseElo(currentElos, types, winnerSeat);

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

    // ---- place_bet: hardened validation ----
    if (req.method === 'POST' && action === 'place_bet') {
      const body = await readJsonBody(req, MAX_SMALL_BODY_BYTES);
      const match_id = requireUuid(body.match_id, 'invalid_match_id');
      const { viewer_id, nickname, seat, stake } = body;
      if (typeof viewer_id !== 'string' || !VIEWER_ID_RE.test(viewer_id)) return json({ error: 'invalid_viewer_id' }, 400);
      if (typeof nickname !== 'string' || nickname.length > MAX_NICKNAME_CHARS) return json({ error: 'invalid_nickname' }, 400);

      // Validate stake is a positive integer.
      if (!isIntIn(stake, 1, MAX_STAKE)) {
        return json({ error: 'invalid_stake' }, 400);
      }

      // Reject if match doesn't exist.
      const { data: matchRow, error: matchErr } = await db.from('matches')
        .select('seats, status, winner_seat').eq('id', match_id).maybeSingle();
      if (matchErr) return dbError('place_bet load', matchErr);
      if (!matchRow) return json({ error: 'match_not_found' }, 404);

      // Seat must exist in this match.
      if (!isIntIn(seat, 0, seatCountOf(matchRow.seats) - 1)) {
        return json({ error: 'invalid_seat' }, 400);
      }

      // Reject if match already has a winner (game is over).
      if (matchRow.winner_seat !== null || matchRow.status !== 'in_progress') {
        return json({ error: 'match_already_finished' }, 409);
      }

      // Reject if match already has a settled event.
      const { data: settledRows, error: settledErr } = await db.from('events')
        .select('id').eq('match_id', match_id).eq('type', 'settled').limit(1);
      if (settledErr) return dbError('place_bet settled check', settledErr);
      if (settledRows && settledRows.length > 0) {
        return json({ error: 'match_already_settled' }, 409);
      }

      // Auto-create viewer row if missing (default 1000 points).
      const { data: v } = await db.from('viewers').select('points').eq('viewer_id', viewer_id).maybeSingle();
      if (!v) {
        await db.from('viewers').insert({ viewer_id, nickname, points: 1000 });
      }

      // Deduct points atomically via RPC: only succeeds if points >= stake.
      const { data: deductData, error: deductErr } = await db.rpc('deduct_points', {
        p_viewer_id: viewer_id,
        p_amount: stake,
      });
      if (deductErr) return dbError('place_bet deduct', deductErr);
      if (deductData === null) {
        return json({ error: 'insufficient_points' }, 400);
      }

      const { data: bet, error } = await db.from('bets')
        .insert({ match_id, viewer_id, nickname, seat, stake }).select('id').single();
      if (error || !bet) return dbError('place_bet insert', error);
      return json({ bet_id: bet.id });
    }

    if (req.method === 'GET' && action === 'replays') {
      const { data, error } = await db.from('matches').select('*').eq('status', 'complete').order('created_at', { ascending: false }).limit(50);
      if (error) return dbError('replays', error);
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
    if (err instanceof Reject) return json({ error: err.code }, err.status);
    console.error('[arena-api] unhandled', err);
    return json({ error: 'internal_error' }, 500);
  }
});
