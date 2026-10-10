import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, Eye, EyeOff, Film, Trophy, Dices, Moon } from 'lucide-react';
import type { MatchEvent, MatchRecord, SeatDef } from '@/lib/types';
import { supabase } from '@/lib/db';
import { describeEvent } from './TableView';

interface Props { matchId: string | null }

export default function ReplayView({ matchId }: Props) {
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selected, setSelected] = useState<MatchRecord | null>(null);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase.from('matches').select('*').eq('status', 'complete').order('created_at', { ascending: false }).limit(50);
      if (err) setError(err.message);
      else setMatches((data ?? []) as unknown as MatchRecord[]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!matchId || !matches.length) return;
    const m = matches.find((x) => x.id === matchId);
    if (m) selectMatch(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, matches.length]);

  const selectMatch = async (m: MatchRecord) => {
    setSelected(m);
    setPlaying(false);
    setCursor(0);
    const { data, error: err } = await supabase.from('events').select('*').eq('match_id', m.id).order('seq', { ascending: true });
    if (err) { setError(err.message); return; }
    setEvents(
      (data ?? []).map((r) => ({
        t: new Date(r.created_at ?? 0).getTime(),
        actor: r.actor,
        type: r.type,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        visible_to: r.visible_to,
        latency_ms: r.latency_ms,
        cost_usd: r.cost_usd,
        forfeit: Boolean((r.payload as Record<string, unknown>)?.forfeit),
      })),
    );
  };

  useEffect(() => {
    if (!playing || cursor >= events.length) { if (cursor >= events.length) setPlaying(false); return; }
    const t = setTimeout(() => setCursor((c) => c + 1), 1400);
    return () => clearTimeout(t);
  }, [playing, cursor, events.length]);

  const seats: SeatDef[] = selected ? (selected.seats as unknown as SeatDef[]) : [];
  const visibleEvents = useMemo(() => events.slice(0, cursor), [events, cursor]);

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">
        <h2 className="font-display flex items-center gap-2 text-xl text-cream"><Film className="h-5 w-5 text-gold-400" /> Replays</h2>
        {loading && <p className="text-sm text-stone-500">Loading…</p>}
        {error && <p className="text-sm text-red-300">{error}</p>}
        {!loading && matches.length === 0 && (
          <p className="text-sm text-stone-500">No completed matches yet. Play one in the lobby first.</p>
        )}
        {matches.map((m) => (
          <button key={m.id} onClick={() => selectMatch(m)}
            className={`w-full rounded-xl border p-3 text-left text-sm transition ${selected?.id === m.id ? 'border-gold-400 bg-gold-400/10' : 'border-stone-800 hover:border-stone-600'}`}>
            <p className="flex items-center gap-1.5 font-bold text-cream">
              {m.game === 'liars_dice' ? <Dices className="h-3.5 w-3.5 text-gold-400" /> : <Moon className="h-3.5 w-3.5 text-gold-400" />}
              {m.game === 'liars_dice' ? "Liar's Dice" : 'Werewolf'}
            </p>
            <p className="mt-0.5 text-xs text-stone-400">
              {(m.seats as unknown as SeatDef[]).map((s) => s.name).join(', ')}
            </p>
            {m.winner_seat != null && (
              <p className="mt-0.5 text-xs text-gold-300">Winner: {(m.seats as unknown as SeatDef[])[m.winner_seat]?.name ?? '?'}</p>
            )}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {!selected ? (
          <div className="flex h-96 items-center justify-center rounded-2xl gold-border bg-stone-900/60 text-stone-500">
            Pick a match to replay.
          </div>
        ) : (
          <>
            <div className="felt-table relative overflow-hidden rounded-3xl p-6">
              <AnimatePresence>
                {cursor >= events.length && events.length > 0 && selected.winner_seat != null && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="absolute inset-0 z-20 flex items-center justify-center bg-stone-950/70">
                    <div className="text-center">
                      <Trophy className="mx-auto h-12 w-12 text-gold-400" />
                      <p className="font-display mt-2 text-2xl font-bold text-gold-300">{seats[selected.winner_seat]?.name ?? '?'} wins!</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="mb-4">
                <p className="font-display text-2xl text-cream">
                  {(() => {
                    const bids = visibleEvents.filter((e) => e.type === 'bid');
                    const last = bids[bids.length - 1];
                    if (selected.game === 'werewolf') {
                      const pc = visibleEvents.filter((e) => e.type === 'phase_change');
                      const lastPc = pc[pc.length - 1];
                      return lastPc ? String(lastPc.payload.phase).replace('_', ' ') : 'night';
                    }
                    return last
                      ? `${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][last.payload.qty as number]} ${['', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes'][last.payload.face as number]}`
                      : 'Opening bid';
                  })()}
                </p>
              </div>
              <div className="flex flex-wrap gap-6">
                {seats.map((s, i) => {
                  const lastBidEvent = visibleEvents.filter((e) => e.type === 'call_liar' && e.payload.revealed).slice(-1)[0];
                  const revealed = lastBidEvent?.payload.revealed as number[][] | undefined;
                  const aliveCount = selected.game === 'liars_dice'
                    ? Math.max(0, 5 - visibleEvents.filter((e) => {
                        const rc = e.payload as Record<string, unknown>;
                        if (e.type !== 'call_liar') return false;
                        const t = rc.target as number;
                        const cw = rc.callerWon as boolean;
                        const loser = cw ? t : e.actor;
                        return loser === i;
                      }).length)
                    : 5;
                  const eliminated = selected.game === 'werewolf'
                    ? visibleEvents.some((e) => (e.type === 'night_death' || e.type === 'vote_result') && e.payload.seat === i)
                    : aliveCount === 0;
                  const said = visibleEvents.find((e) => e.type === 'statement' && e.actor === i);
                  return (
                    <div key={i} className="flex w-36 flex-col items-center">
                      {said && <div className="speech-bubble mb-2">{String(said.payload.text)}</div>}
                      <div className={`flex h-14 w-14 items-center justify-center rounded-full font-bold text-stone-950 ${eliminated ? 'opacity-30 grayscale' : ''}`}
                        style={{ background: ['#e8b64c', '#5cb08f', '#c96f4a', '#7aa5d9', '#b08fd9'][i % 5] }}>
                        {s.name.slice(0, 2)}
                      </div>
                      <p className="mt-1.5 text-sm font-bold text-cream">{s.name}</p>
                      <p className="text-xs text-stone-400">{s.kind === 'jev' ? 'Jev' : s.persona}</p>
                      {reveal && selected.game === 'liars_dice' && revealed && (
                        <span className="mt-1 flex gap-0.5">
                          {(revealed[i] ?? []).map((d, k) => <span key={k} className="die" style={{ width: '0.9rem', height: '0.9rem', fontSize: '0.55rem' }}>{d}</span>)}
                        </span>
                      )}
                      {reveal && selected.game === 'werewolf' && (
                        <span className="mt-1 rounded-full bg-stone-950 px-2 py-0.5 text-[10px] text-gold-300">
                          {String((selected.seats as unknown as Array<Record<string, unknown>>)[i]?.role ?? '?')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* scrubber */}
            <div className="flex items-center gap-3 rounded-2xl gold-border bg-stone-900/60 p-4">
              <button onClick={() => setPlaying((p) => !p)} className="flex h-10 w-10 items-center justify-center rounded-full bg-gold-400 text-stone-950 hover:bg-gold-300">
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <input type="range" min={0} max={events.length} value={cursor} onChange={(e) => { setCursor(Number(e.target.value)); setPlaying(false); }}
                className="flex-1 accent-gold-400" />
              <span className="w-16 text-right text-sm text-stone-400">{cursor}/{events.length}</span>
              <button onClick={() => setReveal((v) => !v)} className="flex items-center gap-1.5 rounded-xl border border-stone-700 px-3 py-1.5 text-xs text-stone-300 hover:border-stone-500">
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {reveal ? 'Hide' : 'Reveal'} hidden
              </button>
            </div>

            <div className="rounded-2xl gold-border bg-stone-900/60 p-4">
              <h3 className="font-display mb-2 text-lg text-cream">Event log</h3>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {visibleEvents.map((e, i) => (
                  <div key={i} className="rounded-lg bg-stone-900/80 p-2 text-sm text-stone-300">
                    <span className="font-bold text-gold-300">{e.actor >= 0 ? seats[e.actor]?.name ?? `Seat ${e.actor + 1}` : 'Referee'}</span> {describeEvent(e, selected.game)}
                  </div>
                ))}
                {visibleEvents.length === 0 && <p className="text-sm text-stone-500">Press play to scrub through the match.</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
