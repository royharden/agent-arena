import type { EngineEvent } from './events';

export interface Bid { qty: number; face: number }
export interface PlacedBid extends Bid { by: number }
export interface DicePlayer { name: string; dice: number[] }

export interface DiceState {
  players: DicePlayer[];
  currentBid: PlacedBid | null;
  turn: number;
  history: { seat: number; bid: Bid }[];
  roundStarter: number;
  gameOver: boolean;
  winner: number | null;
  lastChallenge?: { caller: number; target: number; trueCount: number; claimed: number; callerWon: boolean } | null;
}

export type LiarAction = { type: 'bid'; qty: number; face: number } | { type: 'call_liar' };

export function rollDice(n: number): number[] {
  return Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
}

export function newDiceGame(names: string[], starter = 0): DiceState {
  return {
    players: names.map((n) => ({ name: n, dice: rollDice(5) })),
    currentBid: null,
    turn: starter,
    history: [],
    roundStarter: starter,
    gameOver: false,
    winner: null,
    lastChallenge: null,
  };
}

export function totalDice(s: DiceState): number {
  return s.players.reduce((a, p) => a + p.dice.length, 0);
}

export function livingSeats(s: DiceState): number[] {
  return s.players.map((p, i) => (p.dice.length > 0 ? i : -1)).filter((i) => i >= 0);
}

function nextAlive(s: DiceState, from: number): number {
  const alive = livingSeats(s);
  if (alive.length <= 1) return alive[0] ?? from;
  const idx = alive.indexOf(from);
  return alive[(idx + 1) % alive.length];
}

function isLegal(s: DiceState, a: LiarAction): boolean {
  if (s.gameOver) return false;
  if (a.type === 'call_liar') return !!s.currentBid;
  if (a.qty < 1 || a.qty > totalDice(s) || a.face < 1 || a.face > 6) return false;
  if (!s.currentBid) return true;
  if (a.qty > s.currentBid.qty) return true;
  if (a.qty === s.currentBid.qty && a.face > s.currentBid.face) return true;
  return false;
}

export function legalMoves(s: DiceState): LiarAction[] {
  if (s.gameOver) return [];
  const moves: LiarAction[] = [];
  if (s.currentBid) moves.push({ type: 'call_liar' });
  for (let q = s.currentBid ? s.currentBid.qty : 1; q <= totalDice(s); q++) {
    for (let f = 1; f <= 6; f++) {
      if (isLegal(s, { type: 'bid', qty: q, face: f })) moves.push({ type: 'bid', qty: q, face: f });
    }
  }
  return moves;
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

// Probability a bid is true from viewer's seat: own dice known,
// others follow Binomial(count, p = 1/3) since ones are wild.
export function bidOdds(s: DiceState, viewer: number, bid?: Bid): number {
  const b = bid ?? s.currentBid;
  if (!b) return 1;
  const mine = s.players[viewer].dice;
  const have = mine.filter((d) => d === b.face || d === 1).length;
  const need = b.qty - have;
  if (need <= 0) return 1;
  const others = totalDice(s) - mine.length;
  let p = 0;
  for (let k = need; k <= others; k++) p += comb(others, k) * Math.pow(1 / 3, k) * Math.pow(2 / 3, others - k);
  return Math.min(1, p);
}

// At most 8 candidates: call_liar + the 7 most plausible raises ranked
// by a blend of true odds and how believable the bid is to opponents.
export function candidateMoves(s: DiceState, viewer: number): { move: LiarAction; odds: number }[] {
  const out: { move: LiarAction; odds: number }[] = [];
  if (s.currentBid) out.push({ move: { type: 'call_liar' }, odds: 1 - bidOdds(s, viewer) });
  const bids = legalMoves(s)
    .filter((m) => m.type === 'bid')
    .map((m) => {
      const bid = m as { type: 'bid'; qty: number; face: number };
      const odds = bidOdds(s, viewer, bid);
      const credibility = bid.face >= 5 ? 0.9 : 1;
      return { move: m as LiarAction, odds, score: odds * credibility };
    });
  bids.sort((a, b) => b.score - a.score);
  for (const x of bids.slice(0, 7)) out.push({ move: x.move, odds: x.odds });
  return out.slice(0, 8);
}

export function lowestLegalBid(s: DiceState): LiarAction {
  const moves = legalMoves(s).filter((m) => m.type === 'bid') as { type: 'bid'; qty: number; face: number }[];
  if (!moves.length) return { type: 'call_liar' };
  moves.sort((a, b) => a.qty - b.qty || a.face - b.face);
  return moves[0];
}

const everyone = (n: number) => Array.from({ length: n }, (_, i) => i);

export interface ApplyResult { state: DiceState; events: EngineEvent[] }

export function applyDiceAction(s: DiceState, seat: number, a: LiarAction): ApplyResult {
  if (s.gameOver || seat !== s.turn || !isLegal(s, a)) return { state: s, events: [] };

  if (a.type === 'bid') {
    const st = cloneState(s);
    st.history.push({ seat, bid: { qty: a.qty, face: a.face } });
    st.currentBid = { qty: a.qty, face: a.face, by: seat };
    st.turn = nextAlive(st, seat);
    return {
      state: st,
      events: [{
        t: Date.now(), actor: seat, type: 'bid',
        payload: { qty: a.qty, face: a.face },
        visible_to: everyone(st.players.length),
      }],
    };
  }

  // call_liar — resolve the challenge
  const st = cloneState(s);
  const bid = s.currentBid!;
  const caller = seat;
  const target = bid.by;
  const allDice = st.players.flatMap((p) => p.dice);
  const trueCount = allDice.filter((d) => d === bid.face || d === 1).length;
  const callerWon = trueCount < bid.qty;
  st.lastChallenge = { caller, target, trueCount, claimed: bid.qty, callerWon };

  const loser = callerWon ? target : caller;
  st.players[loser].dice.pop();
  const stillAlive = st.players.map((p, i) => ({ p, i })).filter((x) => x.p.dice.length > 0).map((x) => x.i);

  const events: EngineEvent[] = [{
    t: Date.now(), actor: caller, type: 'call_liar',
    payload: { target, bid, trueCount, callerWon, revealed: st.players.map((p) => p.dice) },
    visible_to: everyone(st.players.length),
  }];

  if (stillAlive.length <= 1) {
    st.gameOver = true;
    st.winner = stillAlive[0];
    events.push({
      t: Date.now(), actor: st.winner, type: 'game_over',
      payload: { winner: st.winner },
      visible_to: everyone(st.players.length),
    });
  } else {
    // new round: loser starts (or next alive if eliminated)
    st.currentBid = null;
    st.history = [];
    st.roundStarter = st.players[loser].dice.length > 0 ? loser : nextAlive(st, loser);
    st.turn = st.roundStarter;
    events.push({
      t: Date.now(), actor: st.roundStarter, type: 'round_start',
      payload: { starter: st.roundStarter, eliminated: st.players[loser].dice.length === 0 ? loser : null },
      visible_to: everyone(st.players.length),
    });
  }
  return { state: st, events };
}

function cloneState(s: DiceState): DiceState {
  return {
    ...s,
    players: s.players.map((p) => ({ name: p.name, dice: [...p.dice] })),
    currentBid: s.currentBid ? { ...s.currentBid } : null,
    history: s.history.map((h) => ({ seat: h.seat, bid: { ...h.bid } })),
    lastChallenge: s.lastChallenge ? { ...s.lastChallenge } : null,
  };
}
