import { useEffect, useState } from 'react';
import { Trophy, Crown } from 'lucide-react';
import { supabase } from '@/lib/db';

interface RatingRow { player_type: string; game: string; elo: number; games: number }
interface ViewerRow { viewer_id: string; nickname: string; points: number }

export default function LeaderboardView() {
  const [ratings, setRatings] = useState<RatingRow[]>([]);
  const [viewers, setViewers] = useState<ViewerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [r, v] = await Promise.all([
        supabase.from('ratings').select('*').order('elo', { ascending: false }),
        supabase.from('viewers').select('viewer_id, nickname, points').order('points', { ascending: false }).limit(20),
      ]);
      if (r.error) setError(r.error.message);
      else setRatings(r.data as RatingRow[]);
      if (!v.error) setViewers(v.data as ViewerRow[]);
      setLoading(false);
    })();
  }, []);

  const games = Array.from(new Set(ratings.map((r) => r.game)));

  return (
    <div className="space-y-6">
      <h2 className="font-display flex items-center gap-2 text-2xl text-cream"><Trophy className="h-6 w-6 text-gold-400" /> Leaderboard</h2>
      {loading && <p className="text-stone-500">Loading…</p>}
      {error && <p className="text-red-300">{error}</p>}

      {!loading && ratings.length === 0 && (
        <p className="text-stone-500">No ratings yet — play a match to seed the board.</p>
      )}

      {games.map((g) => (
        <div key={g} className="rounded-2xl gold-border bg-stone-900/60 p-5">
          <h3 className="font-display mb-3 text-lg text-gold-300">{g === 'liars_dice' ? "Liar's Dice" : 'Werewolf Lite'}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-stone-500">
                <th className="pb-2">Player type</th>
                <th className="pb-2">Elo</th>
                <th className="pb-2">Games</th>
              </tr>
            </thead>
            <tbody>
              {ratings.filter((r) => r.game === g).map((r, i) => (
                <tr key={r.player_type} className="border-t border-stone-800">
                  <td className="py-2 font-bold text-cream">
                    {i === 0 && <Crown className="mr-1.5 inline h-4 w-4 text-gold-400" />}
                    {r.player_type}
                  </td>
                  <td className="py-2 text-gold-300">{Math.round(r.elo)}</td>
                  <td className="py-2 text-stone-400">{r.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="rounded-2xl gold-border bg-stone-900/60 p-5">
        <h3 className="font-display mb-3 text-lg text-gold-300">Top viewers</h3>
        {viewers.length === 0 ? (
          <p className="text-sm text-stone-500">No viewers yet.</p>
        ) : (
          <div className="space-y-1.5">
            {viewers.map((v, i) => (
              <div key={v.viewer_id} className="flex items-center justify-between text-sm">
                <span className="text-cream">{i + 1}. {v.nickname}</span>
                <span className="text-gold-300">{v.points.toLocaleString()} pts</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
