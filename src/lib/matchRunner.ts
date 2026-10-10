import type { MatchEvent, SeatDef, GameKind } from './types';
import { callLlmPlayer, callJev } from './ai';
import { mockDiceMove } from './mockPlayer';
import type { DiceState, LiarAction } from '@/engine/dice';
import { applyDiceAction, candidateMoves, legalMoves, lowestLegalBid } from '@/engine/dice';
import type { WolfState, WolfAction } from '@/engine/werewolf';
import { applyWolfAction, legalWolfMoves, visibleWolfState, livingWolfSeats } from '@/engine/werewolf';

export type Speed = 1 | 2 | 0; // 0 = step mode
export type RunnerMode = 'live' | 'mock';

export interface MoveOutcome {
  move: unknown;
  table_talk?: string;
  private_reasoning?: string;
  forfeit: boolean;
  latency_ms?: number | null;
  cost_usd?: number | null;
  raw_jev?: unknown;
}

export interface RunnerHooks {
  onState: (dice: DiceState | null, wolf: WolfState | null) => void;
  onEvent: (e: MatchEvent) => void;
  onThinking: (seat: number | null, label?: string) => void;
  onSpeech: (seat: number, text: string) => void;
  onGameOver: (winnerSeat: number | null) => void;
  shouldStop?: () => boolean;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function moveKey(m: unknown): string {
  return JSON.stringify(m);
}

export class MatchRunner {
  constructor(
    public game: GameKind,
    public seats: SeatDef[],
    public mode: RunnerMode,
    public speed: Speed,
    private hooks: RunnerHooks,
  ) {}

  private dice: DiceState | null = null;
  private wolf: WolfState | null = null;
  private stopRequested = false;
  private stepResolver: (() => void) | null = null;

  requestStop() {
    this.stopRequested = true;
    this.stepResolver?.();
  }

  /** In step mode, advance one action. */
  resume() {
    this.stepResolver?.();
    this.stepResolver = null;
  }

  private async pace(): Promise<boolean> {
    if (this.stopRequested) return false;
    if (this.speed === 0) {
      await new Promise<void>((resolve) => { this.stepResolver = resolve; });
      return !this.stopRequested;
    }
    await delay(1200 / this.speed);
    return !this.stopRequested;
  }

  async run(): Promise<void> {
    if (this.game === 'liars_dice') await this.runDice();
    else await this.runWolf();
  }

  // ---------- Liar's Dice ----------

  private async runDice() {
    this.dice = { players: this.seats.map((s) => ({ name: s.name, dice: [] })), currentBid: null, turn: 0, history: [], roundStarter: 0, gameOver: false, winner: null, lastChallenge: null };
    // roll real dice client-side for display; engine re-rolls internally
    const names = this.seats.map((s) => s.name);
    let state = freshDice(names);
    this.dice = state;
    this.hooks.onState(state, null);
    let guard = 0;
    while (!state.gameOver && guard++ < 400) {
      if (!(await this.pace())) return;
      const seat = state.turn;
      const outcome = await this.getDiceMove(state, seat);
      if (this.stopRequested) return;
      if (outcome.table_talk) this.hooks.onSpeech(seat, outcome.table_talk);
      this.hooks.onThinking(null);
      let attempts = 0;
      let move = outcome.move as LiarAction;
      let forfeit = outcome.forfeit;
      const legal = legalMoves(state).map(moveKey);
      while (!legal.includes(moveKey(move)) && attempts < 1) {
        attempts += 1;
        this.hooks.onThinking(seat, 'retrying…');
        const retry = await this.getDiceMove(state, seat);
        move = retry.move as LiarAction;
        forfeit = retry.forfeit || forfeit;
      }
      if (!legal.includes(moveKey(move))) {
        move = state.currentBid ? { type: 'call_liar' } : lowestLegalBid(state);
        forfeit = true;
      }
      const before = state.players[seat].dice.length;
      const result = applyDiceAction(state, seat, move);
      if (result.events.length === 0) continue; // truly stuck, skip turn
      state = result.state;
      this.dice = state;
      this.hooks.onState(state, null);
      for (const ev of result.events) {
        this.hooks.onEvent({
          t: ev.t, actor: ev.actor, type: ev.type, payload: ev.payload, visible_to: ev.visible_to,
          latency_ms: outcome.latency_ms ?? null,
          cost_usd: outcome.cost_usd ?? null,
          forfeit,
          table_talk: outcome.table_talk,
          private_reasoning: outcome.private_reasoning,
          raw_jev: outcome.raw_jev,
        });
      }
      void before;
      if (state.gameOver) break;
    }
    this.hooks.onState(state, null);
    this.hooks.onGameOver(state.winner);
  }

  private async getDiceMove(state: DiceState, seat: number): Promise<MoveOutcome> {
    const seatDef = this.seats[seat];
    const cands = candidateMoves(state, seat);
    const legal = legalMoves(state);

    if (seatDef.kind === 'jev') {
      this.hooks.onThinking(seat, 'Jev thinking…');
      const questions: Record<string, unknown> = {
        move: {
          type: 'choice',
          instructions: "You are playing Liar's Dice (ones are wild). Given my_dice, dice_in_play, and current_bid, which move gives you the best chance to win this round?",
          criteria: Object.fromEntries([
            ...cands.map((c, i) => [`m${i}`, describeMove(c.move, state)]),
            ['uncertain', "Can't tell."],
          ]),
        },
      };
      const recentBids = state.history.slice(-6).map((h) => `${qtyWord(h.bid.qty)} ${faceName(h.bid.face)} by ${this.seats[h.seat].name}`);
      const jState = {
        my_dice: state.players[seat].dice,
        dice_in_play: state.players.reduce((a, p) => a + p.dice.length, 0),
        current_bid: state.currentBid ? `${qtyWord(state.currentBid.qty)} ${faceName(state.currentBid.face)}` : null,
        recent_bids: recentBids,
        dice_counts: state.players.map((p, i) => ({ player: this.seats[i].name, dice: p.dice.length })),
      };
      const res = await callJev('player', jState, questions);
      const raw = res.answers;
      const choice = extractChoice(raw?.move ?? raw);
      if (choice === 'uncertain' || choice === null) {
        // fall back to highest-odds candidate
        const best = bestOddsCandidate(state, seat);
        return { move: best, forfeit: false, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw };
      }
      const idx = Number(choice.replace('m', ''));
      if (!Number.isNaN(idx) && cands[idx] && legal.some((l) => moveKey(l) === moveKey(cands[idx].move))) {
        return { move: cands[idx].move, forfeit: false, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw };
      }
      return { move: { type: 'call_liar' }, forfeit: true, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw };
    }

    if (this.mode === 'mock') {
      this.hooks.onThinking(seat, 'thinking…');
      await delay(300);
      const { move, table_talk } = mockDiceMove(state, seat, seatDef.persona ?? 'Analyst');
      return { move, table_talk, forfeit: false };
    }

    this.hooks.onThinking(seat, 'LLM thinking…');
    const visible = {
      your_dice: state.players[seat].dice,
      dice_counts_per_player: state.players.map((p, i) => ({ player: this.seats[i].name, dice: p.dice.length, you: i === seat })),
      current_bid: state.currentBid ? `${qtyWord(state.currentBid.qty)} ${faceName(state.currentBid.face)}` : null,
      bid_history: state.history.slice(-6),
      total_dice: state.players.reduce((a, p) => a + p.dice.length, 0),
    };
    const res = await callLlmPlayer('liars_dice', seatDef.persona ?? 'Analyst', visible, legal);
    if (res.error || res.move === null) return { move: { type: 'call_liar' }, forfeit: true, private_reasoning: res.private_reasoning };
    return { move: res.move, table_talk: res.table_talk, private_reasoning: res.private_reasoning, forfeit: false };
  }

  // ---------- Werewolf ----------

  private async runWolf() {
    let state = freshWolf(this.seats.map((s) => s.name));
    this.wolf = state;
    this.hooks.onState(null, state);
    let guard = 0;
    while (state.phase !== 'game_over' && guard++ < 600) {
      if (!(await this.pace())) return;
      if (state.phase === 'night') {
        const wolfSeat = state.players.findIndex((p) => p.alive && p.role === 'werewolf');
        const seerSeat = state.players.findIndex((p) => p.alive && p.role === 'seer');
        const living = livingWolfSeats(state);
        if (wolfSeat >= 0) {
          const outcome = await this.getWolfMove(state, wolfSeat, 'night_kill', living.filter((i) => i !== wolfSeat));
          if (this.stopRequested) return;
          if (outcome.table_talk) this.hooks.onSpeech(wolfSeat, outcome.table_talk);
          const move: WolfAction = { type: 'wolf_kill', target: Number(outcome.move && (outcome.move as { target: number }).target) };
          const valid = legalWolfMoves(state, wolfSeat).some((m) => m.type === 'wolf_kill' && m.target === move.target);
          const r = applyWolfAction(state, wolfSeat, valid ? move : { type: 'wolf_kill', target: living.find((i) => i !== wolfSeat)! });
          state = r.state;
          this.wolf = state;
          this.hooks.onState(null, state);
          for (const ev of r.events) this.emitWolf(ev, outcome, valid);
        }
        if (seerSeat >= 0 && state.phase === 'night') {
          const outcome = await this.getWolfMove(state, seerSeat, 'seer', living.filter((i) => i !== seerSeat));
          if (this.stopRequested) return;
          const move: WolfAction = { type: 'seer_check', target: Number(outcome.move && (outcome.move as { target: number }).target) };
          const valid = legalWolfMoves(state, seerSeat).some((m) => m.type === 'seer_check' && m.target === move.target);
          const r = applyWolfAction(state, seerSeat, valid ? move : { type: 'seer_check', target: living.find((i) => i !== seerSeat)! });
          state = r.state;
          this.wolf = state;
          this.hooks.onState(null, state);
          for (const ev of r.events) this.emitWolf(ev, outcome, valid);
        }
      } else if (state.phase === 'day_statements') {
        const living = livingWolfSeats(state);
        const speaker = living[state.statementIdx];
        const outcome = await this.getWolfMove(state, speaker, 'statement', living);
        if (this.stopRequested) return;
        if (outcome.table_talk) this.hooks.onSpeech(speaker, outcome.table_talk);
        const text = typeof outcome.move === 'object' && outcome.move !== null && 'text' in (outcome.move as Record<string, unknown>)
          ? String((outcome.move as { text: unknown }).text).slice(0, 280)
          : (outcome.table_talk ?? '…');
        const r = applyWolfAction(state, speaker, { type: 'statement', text: text.slice(0, 280) });
        state = r.state;
        this.wolf = state;
        this.hooks.onState(null, state);
        for (const ev of r.events) this.emitWolf(ev, outcome, true);
        if (state.phase === 'day_vote') {
          // referee batch over all statements
          await this.refereePass(state);
        }
      } else if (state.phase === 'day_vote') {
        const living = livingWolfSeats(state);
        const voter = living.find((i) => !(i in state.votes));
        if (voter === undefined) continue;
        const others = living.filter((i) => i !== voter);
        const outcome = await this.getWolfMove(state, voter, 'vote', others);
        if (this.stopRequested) return;
        const rawTarget = outcome.move && typeof outcome.move === 'object' && 'target' in (outcome.move as Record<string, unknown>)
          ? Number((outcome.move as { target: unknown }).target)
          : NaN;
        const valid = others.includes(rawTarget);
        const r = applyWolfAction(state, voter, { type: 'vote', target: valid ? rawTarget : -1 });
        state = r.state;
        this.wolf = state;
        this.hooks.onState(null, state);
        for (const ev of r.events) this.emitWolf(ev, outcome, valid);
        if (state.phase === 'game_over') break;
      }
    }
    this.hooks.onState(null, state);
    this.hooks.onGameOver(state.winner === 'village' ? -2 : -1);
  }

  private emitWolf(ev: { t: number; actor: number; type: string; payload: Record<string, unknown>; visible_to: number[] | null }, outcome: MoveOutcome, legal: boolean) {
    this.hooks.onEvent({
      t: ev.t, actor: ev.actor, type: ev.type, payload: ev.payload, visible_to: ev.visible_to,
      latency_ms: outcome.latency_ms ?? null,
      cost_usd: outcome.cost_usd ?? null,
      forfeit: !legal || outcome.forfeit,
      table_talk: outcome.table_talk,
      private_reasoning: outcome.private_reasoning,
      raw_jev: outcome.raw_jev,
    });
  }

  private async getWolfMove(
    state: WolfState,
    seat: number,
    phaseKind: 'night_kill' | 'seer' | 'statement' | 'vote',
    candidates: number[],
  ): Promise<MoveOutcome> {
    const seatDef = this.seats[seat];
    const vis = visibleWolfState(state, seat);

    if (seatDef.kind === 'jev') {
      this.hooks.onThinking(seat, 'Jev thinking…');
      const names = candidates.map((i) => this.seats[i].name);
      const instructions = phaseKind === 'vote'
        ? 'Who is most likely to be the werewolf? Pick one living player to vote out, or nobody.'
        : phaseKind === 'night_kill'
          ? 'You are the werewolf. Pick a player to eliminate tonight. Choose someone who suspects you.'
          : phaseKind === 'seer'
            ? 'You are the seer. Choose a player whose role you want to learn tonight.'
            : 'Give a short day statement as the table_talk.';
      const questions: Record<string, unknown> = {
        move: {
          type: 'choice',
          instructions,
          criteria: Object.fromEntries([
            ...names.map((n, i) => [`m${i}`, n]),
            ...(phaseKind === 'vote' || phaseKind === 'statement' ? [['nobody', 'Abstain / say nothing']] : []),
            ['uncertain', "Can't tell."],
          ]),
        },
      };
      const res = await callJev('player', {
        role: vis.role,
        day: vis.day,
        phase: vis.phase,
        living: vis.livingPlayers,
        statements: vis.statements,
        your_knowledge: vis.seerKnowledge,
      }, questions);
      const raw = res.answers;
      const choice = extractChoice(raw?.move ?? raw);
      if (choice === null || choice === 'uncertain') {
        const fallback = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : -1;
        return { move: { target: fallback }, forfeit: false, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw, table_talk: phaseKind === 'statement' ? 'I have nothing to hide.' : undefined };
      }
      if (choice === 'nobody') return { move: { target: -1 }, forfeit: false, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw, table_talk: 'I pass this round.' };
      const idx = Number(choice.replace('m', ''));
      if (!Number.isNaN(idx) && candidates[idx] !== undefined) {
        return { move: { target: candidates[idx] }, forfeit: false, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw };
      }
      return { move: { target: -1 }, forfeit: true, latency_ms: res.latency_ms ?? null, cost_usd: res.cost_usd ?? null, raw_jev: raw };
    }

    if (this.mode === 'mock') {
      this.hooks.onThinking(seat, 'thinking…');
      await delay(300);
      if (phaseKind === 'statement') {
        const lines = [
          'I was just a villager last round, trust me.',
          "I checked nothing, but my gut says you're odd.",
          'I am definitely not the wolf. Definitely.',
          'Can we vote the quiet one for once?',
        ];
        const text = lines[Math.floor(Math.random() * lines.length)];
        return { move: { text }, table_talk: text, forfeit: false };
      }
      if (phaseKind === 'vote') {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        return { move: { target }, forfeit: false };
      }
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      return { move: { target }, forfeit: false };
    }

    // LLM
    this.hooks.onThinking(seat, 'LLM thinking…');
    const persona = seatDef.persona ?? 'Analyst';
    const task = phaseKind === 'statement' ? 'statement' : phaseKind === 'vote' ? 'vote' : 'night';
    const legalList: unknown[] = phaseKind === 'statement'
      ? [{ type: 'statement', text: 'your statement, <= 280 chars' }]
      : candidates.map((i) => ({ target: i, name: this.seats[i].name }));
    const visible = {
      your_role: vis.role,
      day: vis.day,
      phase: vis.phase,
      living_players: vis.livingPlayers,
      statements_today: vis.statements,
      your_private_knowledge: vis.seerKnowledge,
      task,
    };
    const res = await callLlmPlayer('werewolf', persona, visible, legalList);
    if (res.error || res.move === null) {
      return { move: phaseKind === 'statement' ? { text: 'I abstain from talking today.' } : { target: -1 }, forfeit: true, private_reasoning: res.private_reasoning };
    }
    if (phaseKind === 'statement') {
      const text = typeof res.move === 'object' && res.move !== null && 'text' in (res.move as Record<string, unknown>)
        ? String((res.move as { text: unknown }).text)
        : String(res.table_talk ?? 'I have nothing to add.');
      return { move: { text }, table_talk: res.table_talk ?? text, private_reasoning: res.private_reasoning, forfeit: false };
    }
    // vote / night: resolve by name or index
    let target = -1;
    const m = res.move as Record<string, unknown>;
    if (typeof m?.target === 'number') target = m.target;
    else if (typeof m?.name === 'string') {
      const idx = this.seats.findIndex((s) => s.name === m.name);
      if (idx >= 0) target = idx;
    }
    return { move: { target }, table_talk: res.table_talk, private_reasoning: res.private_reasoning, forfeit: target === -1 };
  }

  /** Jev referee: one batched request per day round over all statements. */
  private async refereePass(state: WolfState) {
    const living = livingWolfSeats(state);
    const statements = state.statements.filter((s) => living.includes(s.seat));
    if (!statements.length) return;
    const names = living.map((i) => this.seats[i].name);
    const questions: Record<string, unknown> = {};
    const stateKeys: Record<string, string> = {};
    statements.forEach((s, idx) => {
      stateKeys[`statements.p${idx}`] = s.text;
      questions[`p${idx}__accuses`] = {
        type: 'choice',
        instructions: `Who, if anyone, does statements.p${idx} accuse of being the werewolf?`,
        criteria: Object.fromEntries([...names.map((n) => [n, n]), ['nobody', 'Accuses no one'], ['uncertain', "Can't tell."]]),
      };
      questions[`p${idx}__claims_seer`] = {
        type: 'noul',
        instructions: `Does statements.p${idx} claim to be the seer?`,
      };
      questions[`p${idx}__defensive`] = {
        type: 'noul',
        instructions: `Is statements.p${idx} mainly defending the speaker?`,
      };
    });
    this.hooks.onThinking(-1, 'Jev referee analyzing…');
    const res = await callJev('referee', stateKeys, questions);
    if (this.stopRequested) return;
    this.hooks.onThinking(null);
    this.hooks.onEvent({
      t: Date.now(), actor: -1, type: 'referee_analysis',
      payload: {
        statements: statements.map((s) => ({ seat: s.seat, text: s.text })),
        answers: res.answers ?? null,
        model: res.model ?? null,
      },
      visible_to: null,
      latency_ms: res.latency_ms ?? null,
      cost_usd: res.cost_usd ?? null,
      raw_jev: res.answers,
    });
  }
}

function extractChoice(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.choice === 'string') return o.choice;
    if (typeof o.answer === 'string') return o.answer;
  }
  return null;
}

export function describeMove(m: LiarAction, state: DiceState): string {
  if (m.type === 'call_liar') return `Call liar on ${state.currentBid ? `${qtyWord(state.currentBid.qty)} ${faceName(state.currentBid.face)}` : 'the bid'}.`;
  return `Bid ${qtyWord(m.qty)} ${faceName(m.face)}.`;
}

export function bestOddsCandidate(state: DiceState, viewer: number): LiarAction {
  const cands = candidateMoves(state, viewer).filter((c) => c.move.type === 'bid');
  if (!cands.length) return lowestLegalBid(state);
  return cands[0].move;
}

export function qtyWord(q: number): string {
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  return words[q] ?? String(q);
}

export function faceName(f: number): string {
  return ['', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes'][f];
}

function freshDice(names: string[]): DiceState {
  return {
    players: names.map((n) => ({ name: n, dice: Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6)) })),
    currentBid: null,
    turn: 0,
    history: [],
    roundStarter: 0,
    gameOver: false,
    winner: null,
    lastChallenge: null,
  };
}

function freshWolf(names: string[]): WolfState {
  const roles: Array<'werewolf' | 'seer' | 'villager'> = ['werewolf', 'seer', 'villager', 'villager', 'villager'];
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
