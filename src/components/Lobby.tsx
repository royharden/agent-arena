import { useState } from 'react';
import { Dices, Play, Users, Bot, Cpu, Gauge } from 'lucide-react';
import { PERSONAS, type Persona, type SeatDef, type ViewerState } from '@/lib/types';
import type { MatchSetup } from '@/App';

interface Props {
  viewer: ViewerState;
  onStart: (s: MatchSetup) => void;
  onOpenReplay: (matchId: string) => void;
}

const PERSONA_BLURB: Record<string, string> = {
  Cautious: 'Folds early, calls only when odds scream.',
  Bluffer: 'Overbids with nothing. Loves the drama.',
  Analyst: 'Cold math, tight raises, few surprises.',
  Chaos: 'Coin flips and chaos. Unpredictable by design.',
};

const DEFAULT_NAMES = ['Ana', 'Bo', 'Cy', 'Dee', 'Elf'];

export default function Lobby({ onStart }: Props) {
  const [game, setGame] = useState<'liars_dice' | 'werewolf'>('liars_dice');
  const [seatCount, setSeatCount] = useState(3);
  const [kinds, setKinds] = useState<Array<'llm' | 'jev'>>(['llm', 'llm', 'llm', 'llm', 'llm']);
  const [personas, setPersonas] = useState<Persona[]>(['Cautious', 'Bluffer', 'Analyst', 'Chaos', 'Analyst']);
  const [speed, setSpeed] = useState<1 | 2 | 0>(1);
  const [mockMode, setMockMode] = useState(false);

  const seats: SeatDef[] = Array.from({ length: seatCount }, (_, i) => ({
    seat: i,
    name: DEFAULT_NAMES[i],
    kind: kinds[i],
    persona: kinds[i] === 'llm' ? personas[i] : undefined,
  }));

  const start = () =>
    onStart({ game, seats, speed, mode: mockMode ? 'mock' : 'live' });

  return (
    <div className="space-y-8">
      <section className="rounded-2xl gold-border bg-gradient-to-b from-felt-700/60 to-felt-900/60 p-8 text-center">
        <h1 className="font-display text-4xl font-bold text-gold-400">Watch AI bluff, betray, and bid.</h1>
        <p className="mt-3 text-stone-300">
          LLM players think out loud and lie to each other. Jev picks the optimal move and referees the table. You bet fake points on the winner.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm text-stone-400">
          <span className="flex items-center gap-1.5"><Bot className="h-4 w-4 text-gold-400" /> LLM personas bluff in character</span>
          <span className="flex items-center gap-1.5"><Cpu className="h-4 w-4 text-gold-400" /> Jev plays fast &amp; referees</span>
          <span className="flex items-center gap-1.5"><Gauge className="h-4 w-4 text-gold-400" /> True odds live next to every bid</span>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <GameCard
          active={game === 'liars_dice'}
          onClick={() => setGame('liars_dice')}
          icon={<Dices className="h-8 w-8" />}
          title="Liar's Dice"
          desc="2-4 players, 5 dice each, ones are wild. Bid or call liar — and pray."
        />
        <GameCard
          active={game === 'werewolf'}
          onClick={() => setGame('werewolf')}
          icon={<Moon className="h-8 w-8" />}
          title="Werewolf Lite"
          desc="5 players: 1 werewolf, 1 seer, 3 villagers. Talk, vote, survive 4 days."
        />
      </section>

      <section className="rounded-2xl gold-border bg-stone-900/60 p-6">
        <h2 className="font-display mb-4 flex items-center gap-2 text-xl text-cream"><Users className="h-5 w-5 text-gold-400" /> Quick match setup</h2>

        <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm text-stone-400">Seats: {seatCount}</label>
              <input type="range" min={game === 'werewolf' ? 5 : 2} max={game === 'werewolf' ? 5 : 4} value={seatCount}
                onChange={(e) => setSeatCount(Number(e.target.value))} className="w-full accent-gold-400" />
            </div>

            <div className="space-y-2">
              {seats.map((s, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-stone-900 px-3 py-2">
                  <span className="w-14 text-sm font-bold text-gold-300">Seat {i + 1}</span>
                  <div className="flex overflow-hidden rounded-full border border-stone-700">
                    <button className={`px-3 py-1 text-xs ${s.kind === 'llm' ? 'bg-gold-400/20 text-gold-300' : 'text-stone-400 hover:text-cream'}`}
                      onClick={() => setKinds((k) => k.map((v, j) => (j === i ? 'llm' : v)))}>LLM</button>
                    <button className={`px-3 py-1 text-xs ${s.kind === 'jev' ? 'bg-gold-400/20 text-gold-300' : 'text-stone-400 hover:text-cream'}`}
                      onClick={() => setKinds((k) => k.map((v, j) => (j === i ? 'jev' : v)))}>Jev</button>
                  </div>
                  {s.kind === 'llm' && (
                    <select className="rounded border border-stone-700 bg-stone-800 px-2 py-1 text-xs text-cream"
                      value={personas[i]} onChange={(e) => setPersonas((p) => p.map((v, j) => (j === i ? e.target.value as Persona : v)))}>
                      {PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}
                  {s.kind === 'llm' && <span className="text-xs text-stone-500">{PERSONA_BLURB[personas[i]]}</span>}
                  {s.kind === 'jev' && <span className="text-xs text-stone-500">Fast choice model, plays the odds</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4 lg:w-56">
            <div>
              <span className="mb-1.5 block text-sm text-stone-400">Speed</span>
              <div className="flex gap-1.5">
                {([1, 2, 0] as const).map((sp) => (
                  <button key={sp} onClick={() => setSpeed(sp)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${speed === sp ? 'border-gold-400 bg-gold-400/15 text-gold-300' : 'border-stone-700 text-stone-400 hover:text-cream'}`}>
                    {sp === 0 ? 'Step' : `${sp}x`}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-stone-900 px-3 py-2 text-xs text-stone-300">
              <input type="checkbox" checked={mockMode} onChange={(e) => setMockMode(e.target.checked)} className="accent-gold-400" />
              Mock players (scripted bots)
            </label>
            <button onClick={start}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gold-400 px-4 py-3 font-bold text-stone-950 transition hover:bg-gold-300">
              <Play className="h-4 w-4" /> Start match
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function GameCard({ active, onClick, icon, title, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <button onClick={onClick}
      className={`rounded-2xl border p-6 text-left transition-all ${active ? 'border-gold-400 bg-felt-500/25 shadow-lg shadow-gold-400/5' : 'border-stone-800 bg-stone-900/60 hover:border-stone-600'}`}>
      <div className={active ? 'text-gold-400' : 'text-stone-500'}>{icon}</div>
      <h3 className={`font-display mt-3 text-xl font-bold ${active ? 'text-gold-300' : 'text-cream'}`}>{title}</h3>
      <p className="mt-1 text-sm text-stone-400">{desc}</p>
    </button>
  );
}
