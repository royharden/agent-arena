import type { EngineEvent } from './events';

export type Role = 'werewolf' | 'seer' | 'villager';
export interface WolfPlayer { name: string; alive: boolean; role: Role }

export interface WolfState {
  players: WolfPlayer[];
  phase: 'night' | 'day_statements' | 'day_vote' | 'game_over';
  day: number; // 1-based; max 4 day rounds
  statementIdx: number;
  statements: { seat: number; text: string }[];
  votes: Record<number, number>; // voter seat -> target seat (-1 = abstain)
  nightVictim: number | null;
  seerCheck: { seat: number; result: 'werewolf' | 'not' } | null;
  winner: 'werewolf' | 'village' | null;
  eliminated: { seat: number; by: 'vote' | 'night' } | null;
}

export type WolfAction =
  | { type: 'wolf_kill'; target: number }
  | { type: 'seer_check'; target: number }
  | { type: 'statement'; text: string }
  | { type: 'vote'; target: number } // -1 abstain
  | { type: 'abstain' };

export interface WolfVisibleState {
  you: number;
  role: Role;
  day: number;
  phase: string;
  livingPlayers: { seat: number; name: string }[];
  statements: { seat: number; text: string }[];
  seerKnowledge: { seat: number; result: 'werewolf' | 'not' }[] | null;
}

export function newWolfGame(names: string[]): WolfState {
  const roles: Role[] = ['werewolf', 'seer', 'villager', 'villager', 'villager'];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return {
    players: names.map((n, i) => ({ name: n, alive: true, role: roles[i] })),
    phase: 'night',
    day: 1,
    statementIdx: 0,
    statements: [],
    votes: {},
    nightVictim: null,
    seerCheck: null,
    winner: null,
    eliminated: null,
  };
}

export function livingWolfSeats(s: WolfState): number[] {
  return s.players.map((_, i) => i).filter((i) => s.players[i].alive);
}

function checkWin(s: WolfState) {
  const alive = livingWolfSeats(s);
  const wolvesAlive = alive.filter((i) => s.players[i].role === 'werewolf').length;
  if (wolvesAlive === 0) s.winner = 'village';
  else if (wolvesAlive >= alive.length - wolvesAlive) s.winner = 'werewolf';
  if (s.winner) {
    s.phase = 'game_over';
  }
}

export function legalWolfMoves(s: WolfState, seat: number): WolfAction[] {
  const living = livingWolfSeats(s);
  switch (s.phase) {
    case 'night': {
      if (s.players[seat].role === 'werewolf' && s.players[seat].alive) {
        return living.filter((t) => t !== seat).map((t): WolfAction => ({ type: 'wolf_kill', target: t }));
      }
      if (s.players[seat].role === 'seer' && s.players[seat].alive) {
        return living.filter((t) => t !== seat).map((t): WolfAction => ({ type: 'seer_check', target: t }));
      }
      return [];
    }
    case 'day_statements':
      return living[s.statementIdx] === seat ? [{ type: 'statement', text: '' }] : [];
    case 'day_vote':
      if (s.players[seat].alive && !(seat in s.votes)) {
        const votes: WolfAction[] = living.map((t): WolfAction => ({ type: 'vote', target: t }));
        votes.push({ type: 'vote', target: -1 });
        return votes;
      }
      return [];
    default:
      return [];
  }
}

export function visibleWolfState(s: WolfState, viewer: number): WolfVisibleState {
  const you = s.players[viewer];
  const living = livingWolfSeats(s);
  return {
    you: viewer,
    role: you.role,
    day: s.day,
    phase: s.phase,
    livingPlayers: living.map((i) => ({ seat: i, name: s.players[i].name })),
    statements: s.statements.filter((st) => living.includes(st.seat) || s.phase !== 'day_statements'),
    seerKnowledge: you.role === 'seer' ? (s.seerCheck ? [s.seerCheck] : []) : null,
  };
}

const ALL = (n: number) => Array.from({ length: n }, (_, i) => i);

export interface WolfApplyResult { state: WolfState; events: EngineEvent[] }

export function applyWolfAction(s: WolfState, seat: number, a: WolfAction): WolfApplyResult {
  if (s.phase === 'game_over') return { state: s, events: [] };
  const st: WolfState = JSON.parse(JSON.stringify(s));
  const events: EngineEvent[] = [];
  const n = st.players.length;

  const advanceStatements = () => {
    st.statementIdx += 1;
    const living = livingWolfSeats(st);
    if (st.statementIdx >= living.length) {
      st.phase = 'day_vote';
      st.votes = {};
      events.push({ t: Date.now(), actor: -1, type: 'phase_change', payload: { phase: 'day_vote' }, visible_to: ALL(n) });
    }
  };

  switch (s.phase) {
    case 'night': {
      if (a.type === 'wolf_kill' && st.players[seat].role === 'werewolf' && st.players[seat].alive) {
        st.nightVictim = a.target;
        events.push({ t: Date.now(), actor: seat, type: 'wolf_kill', payload: { target: a.target }, visible_to: [seat] });
      } else if (a.type === 'seer_check' && st.players[seat].role === 'seer' && st.players[seat].alive) {
        const result: 'werewolf' | 'not' = st.players[a.target].role === 'werewolf' ? 'werewolf' : 'not';
        st.seerCheck = { seat: a.target, result };
        events.push({ t: Date.now(), actor: seat, type: 'seer_check', payload: { target: a.target, result }, visible_to: [seat] });
      }
      const seerAlive = st.players.some((p) => p.role === 'seer' && p.alive);
      const nightDone = st.nightVictim !== null && (st.seerCheck !== null || !seerAlive);
      if (nightDone) {
        const victim = st.nightVictim!;
        st.players[victim].alive = false;
        st.eliminated = { seat: victim, by: 'night' };
        events.push({ t: Date.now(), actor: -1, type: 'night_death', payload: { seat: victim }, visible_to: ALL(n) });
        st.nightVictim = null;
        st.seerCheck = null;
        st.phase = 'day_statements';
        st.statements = [];
        st.statementIdx = 0;
        checkWin(st);
        if (!st.winner) {
          events.push({ t: Date.now(), actor: -1, type: 'phase_change', payload: { phase: 'day_statements', day: st.day }, visible_to: ALL(n) });
        }
      }
      break;
    }
    case 'day_statements': {
      if (a.type !== 'statement') return { state: s, events: [] };
      const text = a.text.slice(0, 280);
      st.statements.push({ seat, text });
      events.push({ t: Date.now(), actor: seat, type: 'statement', payload: { text }, visible_to: ALL(n) });
      advanceStatements();
      break;
    }
    case 'day_vote': {
      if (a.type !== 'vote' && a.type !== 'abstain') return { state: s, events: [] };
      const target = a.type === 'abstain' ? -1 : a.target;
      if (seat in st.votes) break;
      st.votes[seat] = target;
      events.push({ t: Date.now(), actor: seat, type: 'vote', payload: { target }, visible_to: ALL(n) });
      const living = livingWolfSeats(st);
      if (!living.every((i) => i in st.votes)) break;
      const tally: Record<number, number> = {};
      for (const t of Object.values(st.votes)) if (t >= 0) tally[t] = (tally[t] ?? 0) + 1;
      let maxV = 0;
      let out = -1;
      for (const [t, c] of Object.entries(tally)) if (c > maxV) { maxV = c; out = Number(t); }
      if (out >= 0) {
        st.players[out].alive = false;
        st.eliminated = { seat: out, by: 'vote' };
        events.push({ t: Date.now(), actor: -1, type: 'vote_result', payload: { seat: out, tally }, visible_to: ALL(n) });
      } else {
        events.push({ t: Date.now(), actor: -1, type: 'vote_result', payload: { seat: null, tally }, visible_to: ALL(n) });
      }
      checkWin(st);
      if (!st.winner && st.day >= 4) {
        st.winner = 'werewolf';
        st.phase = 'game_over';
        events.push({ t: Date.now(), actor: -1, type: 'game_over', payload: { winner: st.winner, reason: 'day_limit' }, visible_to: ALL(n) });
      } else if (!st.winner) {
        st.day += 1;
        st.phase = 'night';
        st.votes = {};
        st.statements = [];
        st.statementIdx = 0;
        st.seerCheck = null;
        st.nightVictim = null;
        events.push({ t: Date.now(), actor: -1, type: 'phase_change', payload: { phase: 'night', day: st.day }, visible_to: ALL(n) });
      }
      break;
    }
  }
  return { state: st, events };
}
