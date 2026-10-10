import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Play, StepForward, X, Eye, EyeOff, Brain, Coins, Trophy, Timer, Zap, AlertTriangle,
} from 'lucide-react';
import type { MatchSetup } from '@/App';
import type { MatchEvent, SeatDef, ViewerState } from '@/lib/types';
import { MatchRunner } from '@/lib/matchRunner';
import { placeBet, saveMatch, settleMatch, oddsFor } from '@/lib/bets';
import { bidOdds, type DiceState } from '@/engine/dice';
import type { WolfState } from '@/engine/werewolf';

interface Props {
  setup: MatchSetup;
  viewer: ViewerState;
  onExit: () => void;
  onPointsChange: (points: number) => void;
}

const AVATAR_COLORS = ['#e8b64c', '#5cb08f', '#c96f4a', '#7aa5d9', '#b08fd9'];

export default function TableView({ setup, viewer, onExit, onPointsChange }: Props) {
  const [dice, setDice] = useState<DiceState | null>(null);
  const [wolf, setWolf] = useState<WolfState | null>(null);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [thinking, setThinking] = useState<{ seat: number | null; label?: string }>({ seat: null });
  const [speech, setSpeech] = useState<Record<number, string>>({});
  const [phase, setPhase] = useState<'betting' | 'playing' | 'done'>('betting');
  const [betSeat, setBetSeat] = useState<number | null>(null);
  const [stake, setStake] = useState(100);
  const [odds, setOdds] = useState<number[]>([]);
  const [winner, setWinner] = useState<number | null>(null);
  const [payout, setPayout] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const runnerRef = useRef<MatchRunner | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const settleBets = async (winnerSeat: number | null, matchId: string | null) => {
    // In a real flow bets were placed through arena-api before the match; we
    // settle Elo + (no-op if no bet) ratings here.
    const types = setup.seats.map((s) => (s.kind === 'jev' ? 'Jev' : `LLM ${s.persona}`));
    const updates = types.map((t) => ({ player_type: t, game: setup.game, new_elo: 1200, games_delta: 1 }));
    if (matchId) {
      await settleMatch(matchId, winnerSeat ?? -1, [], updates);
    }
  };

  const startPlaying = async () => {
    setPhase('playing');
    const runner = new MatchRunner(setup.game, setup.seats as never, setup.mode, setup.speed, {
      onState: (d, w) => { setDice(d); setWolf(w); },
      onEvent: (e) => setEvents((prev) => [...prev, e]),
      onThinking: (seat, label) => setThinking({ seat, label }),
      onSpeech: (seat, text) => setSpeech((s) => ({ ...s, [seat]: text })),
      onGameOver: async (winnerSeat) => {
        setWinner(winnerSeat);
        setPhase('done');
        const res = await saveMatch(setup.game, setup.seats as never, winnerSeat, events);
        if (res.match_id) await settleBets(winnerSeat, res.match_id);
        // payout messaging
        if (betSeat === winnerSeat && betSeat !== null) {
          const o = odds[betSeat] ?? 2;
          setPayout(`You won ${(stake * o).toFixed(0)} points!`);
          onPointsChange(viewer.points + Math.round(stake * o));
        } else if (betSeat !== null) {
          setPayout('Your bet lost. Better luck next match.');
        }
      },
      shouldStop: () => false,
    });
    runnerRef.current = runner;
    await runner.run();
  };

  const startWithBet = async () => {
    if (betSeat === null) return startPlaying();
    // create a lightweight match shell to attach the bet to
    const res = await saveMatch(setup.game, setup.seats as never, null, []);
    if (res.match_id) {
      const b = await placeBet(res.match_id, viewer, betSeat, stake);
      if (b.error) {
        setPayout(`Bet failed: ${b.error}`);
      } else {
        onPointsChange(viewer.points - stake);
      }
    }
    await startPlaying();
  };

  useEffect(() => {
    // odds from default 1200 Elo, slightly varied per seat for display
    setOdds(setup.seats.map((_, i) => oddsFor(1200 + (i - 2) * 10, setup.seats.map((_, j) => 1200 + (j - 2) * 10))));
  }, [setup.seats]);

  const stop = () => {
    runnerRef.current?.requestStop();
  };

  const resume = () => runnerRef.current?.resume();

  const seatLabel = (i: number) => setup.seats[i]?.name ?? `Seat ${i}`;

  const trueOddsForSeat = (i: number): number | null => {
    if (!dice || dice.gameOver || dice.turn !== i || !dice.currentBid) return null;
    return 1 - bidOdds(dice, i);
  };

  const currentBidText = dice?.currentBid
    ? `${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][dice.currentBid.qty] ?? dice.currentBid.qty} ${['', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes'][dice.currentBid.face]}`
    : 'Opening bid';

  const isWerewolfNight = wolf && wolf.phase === 'night';

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        {/* stage */}
        <div className={`felt-table relative overflow-hidden rounded-3xl p-6 transition-colors duration-1000 ${isWerewolfNight ? 'brightness-[0.55] saturate-50' : ''}`}>
          {/* winner banner */}
          <AnimatePresence>
            {phase === 'done' && (
              <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="absolute inset-0 z-20 flex items-center justify-center bg-stone-950/70 backdrop-blur-sm">
                <div className="text-center">
                  <Trophy className="mx-auto h-14 w-14 text-gold-400" />
                  <h2 className="font-display mt-3 text-3xl font-bold text-gold-300">
                    {winner === -2 ? 'Village wins!' : winner === -1 ? 'Werewolf wins!' : `${seatLabel(winner ?? 0)} wins!`}
                  </h2>
                  {payout && <p className="mt-2 text-stone-300">{payout}</p>}
                  <button onClick={onExit} className="mt-5 rounded-xl bg-gold-400 px-6 py-2 font-bold text-stone-950 hover:bg-gold-300">
                    Back to lobby
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* top bar: current bid / phase */}
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-gold-400/70">{setup.game === 'liars_dice' ? 'Current bid' : `Day ${wolf?.day ?? 1} - ${wolf?.phase?.replace('_', ' ') ?? 'night'}`}</p>
              <p className="font-display text-3xl font-bold text-cream">{currentBidText}</p>
            </div>
            {setup.game === 'werewolf' && (
              <div className="text-right text-xs text-stone-400">
                <p>{wolf?.phase === 'night' ? 'Night falls...' : wolf?.phase === 'day_statements' ? 'Statements' : wolf?.phase === 'day_vote' ? 'Voting' : 'Game over'}</p>
              </div>
            )}
          </div>

          {/* seats around table */}
          <div className="flex flex-wrap items-start justify-center gap-6 py-4">
            {setup.seats.map((s, i) => {
              const eliminated = wolf ? !wolf.players[i]?.alive : dice ? dice.players[i]?.dice.length === 0 : false;
              const isThinking = thinking.seat === i;
              const diceCount = dice ? dice.players[i]?.dice.length ?? 0 : 5;
              return (
                <div key={i} className="relative flex w-40 flex-col items-center">
                  {/* speech bubble */}
                  <AnimatePresence>
                    {speech[i] && (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="speech-bubble mb-2">
                        {speech[i]}
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* avatar */}
                  <motion.div whileHover={{ scale: 1.05 }}
                    className={`relative flex h-16 w-16 items-center justify-center rounded-full text-xl font-bold text-stone-950 shadow-lg ${eliminated ? 'opacity-30 grayscale' : ''}`}
                    style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                    {s.name.slice(0, 2)}
                    {s.kind === 'jev' && <CpuBadge />}
                    {/* thinking indicator */}
                    {isThinking && (
                      <div className="absolute -bottom-2 -right-2 flex gap-0.5 rounded-full bg-stone-950 px-1.5 py-1">
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-gold-400" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-gold-400" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-gold-400" />
                      </div>
                    )}
                  </motion.div>
                  <p className="mt-2 text-sm font-bold text-cream">{seatLabel(i)}</p>
                  <p className="text-xs text-stone-400">{s.kind === 'jev' ? 'Jev' : `${s.persona} LLM`}</p>
                  {/* dice count / status */}
                  <div className="mt-1.5 flex items-center gap-1">
                    {setup.game === 'liars_dice' && (
                      <span className="flex gap-0.5">
                        {Array.from({ length: Math.min(diceCount, 5) }).map((_, d) => (
                          <span key={d} className="die" style={{ width: '0.9rem', height: '0.9rem', fontSize: '0.55rem' }}>{showHidden && (dice?.players[i]?.dice[d] ?? '')}</span>
                        ))}
                      </span>
                    )}
                    {setup.game === 'werewolf' && (
                      <span className={`rounded-full px-2 py-0.5 text-xs ${eliminated ? 'bg-red-500/20 text-red-300' : 'bg-felt-300/20 text-felt-50'}`}>
                        {eliminated ? 'out' : 'alive'}
                      </span>
                    )}
                  </div>
                  {/* true odds chip for current bidder */}
                  {trueOddsForSeat(i) !== null && (
                    <span className="mt-1 rounded-full bg-stone-950/80 px-2 py-0.5 text-[10px] text-gold-300">
                      odds {(trueOddsForSeat(i)! * 100).toFixed(0)}%
                    </span>
                  )}
                  {/* latency */}
                  {events.filter((e) => e.actor === i && e.latency_ms).slice(-1).map((e, k) => (
                    <span key={k} className="mt-1 flex items-center gap-1 text-[10px] text-stone-500">
                      <Timer className="h-3 w-3" /> {e.latency_ms}ms
                    </span>
                  ))}
                </div>
              );
            })}
          </div>

          {/* referee pass indicator for werewolf */}
          {thinking.seat === -1 && (
            <div className="absolute right-4 top-4 flex items-center gap-2 rounded-full bg-stone-950/80 px-3 py-1.5 text-xs text-gold-300">
              <Zap className="h-3.5 w-3.5" /> {thinking.label ?? 'Jev referee analyzing…'}
            </div>
          )}
        </div>

        {/* controls */}
        <div className="flex flex-wrap items-center gap-3">
          {setup.speed === 0 && phase === 'playing' && (
            <button onClick={resume} className="flex items-center gap-2 rounded-xl bg-gold-400 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-gold-300">
              <StepForward className="h-4 w-4" /> Step
            </button>
          )}
          {phase === 'playing' && (
            <button onClick={stop} className="flex items-center gap-2 rounded-xl border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10">
              <X className="h-4 w-4" /> Stop
            </button>
          )}
          <button onClick={() => setShowHidden((v) => !v)} className="ml-auto flex items-center gap-2 rounded-xl border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-stone-500">
            {showHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showHidden ? 'Hide' : 'Reveal'} hidden info
          </button>
        </div>

        {/* suspicion graph for werewolf */}
        {setup.game === 'werewolf' && <SuspicionGraph events={events} seats={setup.seats} />}

        {/* betting panel */}
        {phase === 'betting' && (
          <div className="rounded-2xl gold-border bg-stone-900/60 p-5">
            <h3 className="font-display flex items-center gap-2 text-lg text-cream"><Coins className="h-5 w-5 text-gold-400" /> Place your bet</h3>
            <p className="mt-1 text-sm text-stone-400">Stake fake points on a seat. Odds come from current Elo ratings.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {setup.seats.map((s, i) => (
                <button key={i} onClick={() => setBetSeat(i)}
                  className={`rounded-xl border p-3 text-left transition ${betSeat === i ? 'border-gold-400 bg-gold-400/10' : 'border-stone-800 hover:border-stone-600'}`}>
                  <p className="font-bold text-cream">{s.name}</p>
                  <p className="text-xs text-stone-400">{s.kind === 'jev' ? 'Jev' : s.persona}</p>
                  <p className="mt-1 text-sm text-gold-300">pays {odds[i]?.toFixed(2)}x</p>
                </button>
              ))}
            </div>
            {betSeat !== null && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <input type="range" min={10} max={Math.max(10, Math.min(viewer.points, 500))} value={stake}
                  onChange={(e) => setStake(Number(e.target.value))} className="flex-1 accent-gold-400" />
                <span className="w-24 text-right text-sm font-bold text-gold-300">{stake} pts</span>
                <span className="text-sm text-stone-400">to win {(stake * (odds[betSeat] ?? 2)).toFixed(0)}</span>
              </div>
            )}
            <div className="mt-4 flex gap-3">
              <button onClick={startWithBet} className="flex items-center gap-2 rounded-xl bg-gold-400 px-5 py-2.5 font-bold text-stone-950 hover:bg-gold-300">
                <Play className="h-4 w-4" /> {betSeat !== null ? 'Bet & start' : 'Skip bet & start'}
              </button>
              <button onClick={onExit} className="rounded-xl border border-stone-700 px-4 py-2 text-sm text-stone-400 hover:text-cream">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* side panel: event log */}
      <aside className="rounded-2xl gold-border bg-stone-900/60 p-4 lg:sticky lg:top-20 lg:h-[calc(100vh-6rem)] lg:overflow-y-auto" ref={logRef}>
        <h3 className="font-display mb-3 text-lg text-cream">Event log</h3>
        <div className="space-y-2">
          {events.length === 0 && <p className="text-sm text-stone-500">Waiting for the first move…</p>}
          {events.map((e, i) => (
            <div key={i} className="rounded-lg bg-stone-900/80 p-2.5 text-sm">
              <button className="flex w-full items-center justify-between text-left" onClick={() => setExpanded(expanded === i ? null : i)}>
                <span className="text-cream">
                  <span className="font-bold text-gold-300">{e.actor >= 0 ? seatLabel(e.actor) : 'Referee'}</span>{' '}
                  {describeEvent(e, setup.game)}
                </span>
                {e.forfeit && <span className="ml-2 flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300"><AlertTriangle className="h-3 w-3" />forfeit</span>}
              </button>
              {e.table_talk && <p className="mt-1 text-xs italic text-stone-400">"{e.table_talk}"</p>}
              {expanded === i && (
                <div className="mt-2 space-y-2 border-t border-stone-800 pt-2">
                  {e.private_reasoning && (
                    <div>
                      <p className="flex items-center gap-1 text-xs font-bold text-stone-400"><Brain className="h-3 w-3" /> Private reasoning</p>
                      <p className="mt-0.5 text-xs text-stone-500">{e.private_reasoning}</p>
                    </div>
                  )}
                  {e.raw_jev != null && (
                    <div>
                      <p className="text-xs font-bold text-stone-400">Raw Jev JSON</p>
                      <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-stone-950 p-2 text-[10px] text-stone-400">{String(JSON.stringify(e.raw_jev, null, 2))}</pre>
                    </div>
                  )}
                  {e.cost_usd != null && (
                    <p className="text-xs text-stone-500">cost ${e.cost_usd.toFixed(6)}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function CpuBadge() {
  return (
    <span className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-950 text-gold-400 ring-1 ring-gold-400/50">
      <Zap className="h-3 w-3" />
    </span>
  );
}

export function describeEvent(e: MatchEvent, game: string): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'bid': {
      const qty = p.qty as number;
      const face = p.face as number;
      return `bids ${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][qty] ?? qty} ${['', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes'][face]}`;
    }
    case 'call_liar':
      return `calls liar on seat ${(p.target as number) + 1}`;
    case 'round_start':
      return `new round — seat ${(p.starter as number) + 1} starts`;
    case 'statement':
      return `says: "${p.text}"`;
    case 'vote':
      return `votes for ${(p.target as number) >= 0 ? `seat ${(p.target as number) + 1}` : 'nobody'}`;
    case 'wolf_kill':
      return 'chooses a victim (hidden)';
    case 'seer_check':
      return `checks seat ${(p.target as number) + 1} (hidden)`;
    case 'night_death':
      return `was eliminated in the night`;
    case 'vote_result':
      return p.seat != null ? `seat ${(p.seat as number) + 1} is voted out` : 'no one is voted out';
    case 'referee_analysis':
      return 'Jev analyzed all statements';
    case 'phase_change':
      return game === 'werewolf' ? `phase: ${String(p.phase).replace('_', ' ')}` : '';
    case 'game_over':
      return 'game over';
    default:
      return e.type;
  }
}

function SuspicionGraph({ events, seats }: { events: MatchEvent[]; seats: SeatDef[] }) {
  // build from referee_analysis events
  const edges: Array<{ from: number; to: number; weight: number }> = [];
  for (const e of events) {
    if (e.type !== 'referee_analysis' || !e.payload?.answers) continue;
    const answers = e.payload.answers as Record<string, unknown>;
    const statements = (e.payload.statements ?? []) as Array<{ seat: number }>;
    statements.forEach((s, idx) => {
      const a = answers[`p${idx}__accuses`];
      const choice = a && typeof a === 'object' ? (a as Record<string, unknown>).choice : null;
      if (typeof choice === 'string' && choice !== 'nobody' && choice !== 'uncertain') {
        const to = seats.findIndex((x) => x.name === choice);
        if (to >= 0) edges.push({ from: s.seat, to, weight: 1 });
      }
    });
  }
  const counts: Record<string, number> = {};
  for (const e of edges) {
    counts[`${e.from}-${e.to}`] = (counts[`${e.from}-${e.to}`] ?? 0) + e.weight;
  }

  return (
    <div className="rounded-2xl gold-border bg-stone-900/60 p-5">
      <h3 className="font-display text-lg text-cream">Who's sus?</h3>
      {Object.keys(counts).length === 0 ? (
        <p className="mt-1 text-sm text-stone-500">Accusations appear here as Jev parses the table talk.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {Object.entries(counts).map(([key, w]) => {
            const [from, to] = key.split('-').map(Number);
            return (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className="w-16 text-right font-bold text-cream">{seats[from]?.name}</span>
                <span className="h-1 rounded-full bg-gold-400" style={{ width: `${Math.min(120, w * 40)}px`, opacity: 0.7 }} />
                <span className="font-bold text-red-300">{seats[to]?.name}</span>
                <span className="text-xs text-stone-500">x{w}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
