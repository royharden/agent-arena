import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Timer, DollarSign, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';
import { supabase } from '@/lib/db';

interface EventRow { actor: number; type: string; latency_ms: number | null; cost_usd: number | null; payload: Record<string, unknown> }
interface MatchRow { id: string; game: string; seats: Array<{ seat: number; name: string; kind: string; persona?: string }> }

export default function StatsView() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [seatMap, setSeatMap] = useState<Record<number, { kind: string; persona?: string }>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: matches } = await supabase.from('matches').select('id, game, seats').limit(20).order('created_at', { ascending: false });
      const all: EventRow[] = [];
      const map: Record<number, { kind: string; persona?: string }> = {};
      for (const m of (matches ?? []) as MatchRow[]) {
        (m.seats ?? []).forEach((s) => { map[s.seat] = { kind: s.kind, persona: s.persona }; });
        const { data: evs } = await supabase.from('events').select('actor, type, latency_ms, cost_usd, payload').eq('match_id', m.id);
        for (const e of evs ?? []) all.push(e as EventRow);
      }
      setRows(all);
      setSeatMap(map);
      setLoading(false);
    })();
  }, []);

  const latencyByType = useMemo(() => {
    const agg: Record<string, { total: number; n: number }> = {};
    for (const e of rows) {
      if (e.latency_ms == null) continue;
      const info = seatMap[e.actor];
      const type = info?.kind === 'jev' ? 'Jev' : `LLM ${info?.persona ?? ''}`.trim();
      agg[type] = agg[type] ?? { total: 0, n: 0 };
      agg[type].total += e.latency_ms;
      agg[type].n += 1;
    }
    return Object.entries(agg).map(([type, v]) => ({ type, avg_latency_ms: Math.round(v.total / v.n), moves: v.n }));
  }, [rows, seatMap]);

  const costByType = useMemo(() => {
    const agg: Record<string, { total: number; n: number }> = {};
    for (const e of rows) {
      if (e.cost_usd == null) continue;
      const info = seatMap[e.actor];
      const type = info?.kind === 'jev' ? 'Jev' : `LLM ${info?.persona ?? ''}`.trim();
      agg[type] = agg[type] ?? { total: 0, n: 0 };
      agg[type].total += e.cost_usd;
      agg[type].n += 1;
    }
    return Object.entries(agg).map(([type, v]) => ({ type, avg_cost_usd: Number((v.total / v.n).toFixed(7)) }));
  }, [rows, seatMap]);

  const forfeitByType = useMemo(() => {
    const agg: Record<string, { forfeit: number; total: number }> = {};
    for (const e of rows) {
      if (!['bid', 'call_liar', 'vote', 'statement', 'wolf_kill', 'seer_check'].includes(e.type)) continue;
      const info = seatMap[e.actor];
      const type = info?.kind === 'jev' ? 'Jev' : `LLM ${info?.persona ?? ''}`.trim();
      agg[type] = agg[type] ?? { forfeit: 0, total: 0 };
      agg[type].total += 1;
      if (e.payload?.forfeit) agg[type].forfeit += 1;
    }
    return Object.entries(agg).map(([type, v]) => ({ type, forfeit_pct: Math.round((v.forfeit / v.total) * 100) }));
  }, [rows, seatMap]);

  const hasData = rows.length > 0;

  return (
    <div className="space-y-6">
      <h2 className="font-display flex items-center gap-2 text-2xl text-cream"><BarChart3 className="h-6 w-6 text-gold-400" /> Arena stats</h2>
      {loading && <p className="text-stone-500">Loading…</p>}

      {!loading && !hasData && (
        <p className="text-stone-500">No match data yet. Play a match to populate stats.</p>
      )}

      {hasData && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl gold-border bg-stone-900/60 p-5">
            <h3 className="mb-4 flex items-center gap-2 text-lg text-cream"><Timer className="h-5 w-5 text-gold-400" /> Avg decision latency per move</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={latencyByType}>
                <XAxis dataKey="type" tick={{ fill: '#a8a29e', fontSize: 11 }} />
                <YAxis tick={{ fill: '#a8a29e', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#1c1917', border: '1px solid #44403c', borderRadius: 8, color: '#f5efe0' }} />
                <Bar dataKey="avg_latency_ms" fill="#e8b64c" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-2xl gold-border bg-stone-900/60 p-5">
            <h3 className="mb-4 flex items-center gap-2 text-lg text-cream"><DollarSign className="h-5 w-5 text-gold-400" /> Avg cost per move (USD)</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={costByType}>
                <XAxis dataKey="type" tick={{ fill: '#a8a29e', fontSize: 11 }} />
                <YAxis tick={{ fill: '#a8a29e', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#1c1917', border: '1px solid #44403c', borderRadius: 8, color: '#f5efe0' }} />
                <Bar dataKey="avg_cost_usd" fill="#5cb08f" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-2xl gold-border bg-stone-900/60 p-5 lg:col-span-2">
            <h3 className="mb-4 flex items-center gap-2 text-lg text-cream"><AlertTriangle className="h-5 w-5 text-gold-400" /> Forfeit share by player type (%)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={forfeitByType}>
                <CartesianGrid stroke="#292524" />
                <XAxis dataKey="type" tick={{ fill: '#a8a29e', fontSize: 11 }} />
                <YAxis tick={{ fill: '#a8a29e', fontSize: 11 }} unit="%" />
                <Tooltip contentStyle={{ background: '#1c1917', border: '1px solid #44403c', borderRadius: 8, color: '#f5efe0' }} />
                <Line type="monotone" dataKey="forfeit_pct" stroke="#c96f4a" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
