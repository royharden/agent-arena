import { arenaApiUrl, edgeHeaders } from './supabase';
import type { SeatDef, MatchEvent, ViewerState } from './types';

export interface PlaceBetResult { bet_id?: string; error?: string }

export async function placeBet(
  matchId: string,
  viewer: ViewerState,
  seat: number,
  stake: number,
): Promise<PlaceBetResult> {
  try {
    const res = await fetch(arenaApiUrl('place_bet'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({ match_id: matchId, viewer_id: viewer.viewer_id, nickname: viewer.nickname, seat, stake }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` };
    return { bet_id: body.bet_id };
  } catch {
    return { error: 'network_error' };
  }
}

export async function saveMatch(
  game: string,
  seats: SeatDef[],
  winnerSeat: number | null,
  events: MatchEvent[],
): Promise<{ match_id?: string; error?: string }> {
  try {
    const res = await fetch(arenaApiUrl('save_match'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({
        match: { game, seats, winner_seat: winnerSeat },
        events: events.map((e) => ({
          seq: 0, actor: e.actor, type: e.type, payload: e.payload,
          visible_to: e.visible_to, latency_ms: e.latency_ms, cost_usd: e.cost_usd,
        })).map((e, i) => ({ ...e, seq: i })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` };
    return { match_id: body.match_id };
  } catch {
    return { error: 'network_error' };
  }
}

export async function updateMatch(
  matchId: string,
  winnerSeat: number | null,
  events: MatchEvent[],
): Promise<{ error?: string }> {
  try {
    const res = await fetch(arenaApiUrl('update_match'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({
        match_id: matchId,
        winner_seat: winnerSeat,
        events: events.map((e) => ({
          seq: 0, actor: e.actor, type: e.type, payload: e.payload,
          visible_to: e.visible_to, latency_ms: e.latency_ms, cost_usd: e.cost_usd,
        })).map((e, i) => ({ ...e, seq: i })),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.error ?? `HTTP ${res.status}` };
    }
    return {};
  } catch {
    return { error: 'network_error' };
  }
}

export async function settleMatch(matchId: string): Promise<{ error?: string }> {
  try {
    const res = await fetch(arenaApiUrl('settle'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({ match_id: matchId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.error ?? `HTTP ${res.status}` };
    }
    return {};
  } catch {
    return { error: 'network_error' };
  }
}

// Odds from Elo: underdog pays more.
export function oddsFor(eloSeat: number, eloOthers: number[]): number {
  const avgOthers = eloOthers.reduce((a, b) => a + b, 0) / Math.max(1, eloOthers.length);
  const expected = 1 / (1 + Math.pow(10, (avgOthers - eloSeat) / 400));
  const fair = 1 / Math.max(0.05, expected);
  return Math.max(1.1, Math.round(fair * 0.95 * 100) / 100);
}

// Multi-player Elo scored pairwise, K = 24.
export function pairwiseEloUpdate(
  elos: Record<string, number>,
  seatToType: string[],
  winnerSeat: number | null,
  k = 24,
): Record<string, number> {
  const out = { ...elos };
  const n = seatToType.length;
  if (winnerSeat === null || winnerSeat < 0) return out;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = seatToType[i];
      const b = seatToType[j];
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
