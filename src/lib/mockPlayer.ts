import type { Persona } from './types';
import type { LiarAction, DiceState } from '@/engine/dice';
import { bidOdds, candidateMoves, lowestLegalBid } from '@/engine/dice';

// Scripted fallback bot per persona, driven by bidOdds thresholds.

const CALL_TALK: Record<Persona, string[]> = {
  Cautious: ['That seems too rich for me.', "I don't buy it.", 'Calling it — too risky to let ride.'],
  Bluffer: ['Oh, absolutely calling that out!', 'Nobody has that many!', 'Caught you bluffing, friend.'],
  Analyst: ['Probability says no.', "The odds don't support that bid.", 'Calling. Math is math.'],
  Chaos: ['LIAR!! (coin flip decided)', 'I just feel it in my bones.', 'Random accusation incoming!'],
};

const BID_TALK: Record<Persona, string[]> = {
  Cautious: ["I'll keep it modest.", 'Small step up from me.', 'Just nudging it along.'],
  Bluffer: ['I am LOADED with these.', 'Trust me, raise it.', "You should all fold — oh wait, wrong game."],
  Analyst: ['Expected value favors this.', 'Statistically sound raise.', "The numbers like this one."],
  Chaos: ['BANANA STANDS!', 'Six of everything!', 'The dice whisper to me.'],
};

export function mockDiceMove(s: DiceState, seat: number, persona: Persona): { move: LiarAction; table_talk: string } {
  if (!s.currentBid) {
    const cands = candidateMoves(s, seat).filter((c) => c.move.type === 'bid');
    const pick = cands[Math.floor(Math.random() * Math.min(3, cands.length))] ?? cands[0];
    return { move: pick.move, table_talk: BID_TALK[persona][Math.floor(Math.random() * 3)] };
  }
  const odds = bidOdds(s, seat);
  const thresholds: Record<Persona, number> = { Cautious: 0.45, Bluffer: 0.35, Analyst: 0.32, Chaos: 0.15 };
  if (odds < thresholds[persona]) {
    return { move: { type: 'call_liar' }, table_talk: CALL_TALK[persona][Math.floor(Math.random() * 3)] };
  }
  if (persona === 'Chaos' && Math.random() < 0.3) {
    return { move: { type: 'call_liar' }, table_talk: CALL_TALK[persona][Math.floor(Math.random() * 3)] };
  }
  const bids = candidateMoves(s, seat).filter((c) => c.move.type === 'bid');
  let pick;
  if (persona === 'Cautious') pick = bids[0];
  else if (persona === 'Analyst') pick = bids[Math.min(1, bids.length - 1)];
  else pick = bids[Math.floor(Math.random() * Math.min(4, bids.length))];
  if (!pick) return { move: lowestLegalBid(s), table_talk: BID_TALK[persona][0] };
  return { move: pick.move, table_talk: BID_TALK[persona][Math.floor(Math.random() * 3)] };
}
