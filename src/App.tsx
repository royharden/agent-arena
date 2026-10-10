import { useState, useEffect } from 'react';
import { Dices, Trophy, BarChart3, Film, Zap } from 'lucide-react';
import { loadViewer, saveNickname, type ViewerState, type SeatDef } from '@/lib/types';
import Lobby from '@/components/Lobby';
import TableView from '@/components/TableView';
import ReplayView from '@/components/ReplayView';
import LeaderboardView from '@/components/LeaderboardView';
import StatsView from '@/components/StatsView';

export type Screen = 'lobby' | 'table' | 'replays' | 'leaderboard' | 'stats';

export interface MatchSetup {
  game: 'liars_dice' | 'werewolf';
  seats: SeatDef[];
  speed: 1 | 2 | 0;
  mode: 'live' | 'mock';
}

function App() {
  const [screen, setScreen] = useState<Screen>('lobby');
  const [viewer, setViewer] = useState<ViewerState>(() => loadViewer());
  const [setup, setSetup] = useState<MatchSetup | null>(null);
  const [replayMatchId, setReplayMatchId] = useState<string | null>(null);

  useEffect(() => {
    // refresh points after a match settles
    if (screen === 'lobby') {
      loadViewerPoints().then((p) => setViewer((v) => ({ ...v, points: p })));
    }
  }, [screen]);

  const startMatch = (s: MatchSetup) => {
    setSetup(s);
    setScreen('table');
  };

  const openReplay = (matchId: string) => {
    setReplayMatchId(matchId);
    setScreen('replays');
  };

  return (
    <div className="min-h-screen bg-stone-950">
      <header className="sticky top-0 z-40 border-b border-gold-400/20 bg-stone-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <button className="flex items-center gap-2 text-gold-400" onClick={() => setScreen('lobby')}>
            <Dices className="h-6 w-6" />
            <span className="font-display text-lg font-bold tracking-wide">Agent Arena</span>
          </button>
          <nav className="ml-6 hidden gap-1 md:flex">
            <NavBtn active={screen === 'lobby'} icon={<Zap className="h-4 w-4" />} label="Lobby" onClick={() => setScreen('lobby')} />
            <NavBtn active={screen === 'replays'} icon={<Film className="h-4 w-4" />} label="Replays" onClick={() => setScreen('replays')} />
            <NavBtn active={screen === 'leaderboard'} icon={<Trophy className="h-4 w-4" />} label="Leaderboard" onClick={() => setScreen('leaderboard')} />
            <NavBtn active={screen === 'stats'} icon={<BarChart3 className="h-4 w-4" />} label="Stats" onClick={() => setScreen('stats')} />
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <input
              className="w-28 rounded border border-gold-400/30 bg-stone-900 px-2 py-1 text-sm text-cream focus:border-gold-400 focus:outline-none"
              value={viewer.nickname}
              onChange={(e) => {
                setViewer((v) => ({ ...v, nickname: e.target.value }));
                saveNickname(e.target.value);
              }}
              aria-label="Your nickname"
            />
            <div className="flex items-center gap-1.5 rounded-full bg-gold-400/10 px-3 py-1 text-sm text-gold-300">
              <span className="font-bold">{viewer.points.toLocaleString()}</span>
              <span className="text-xs text-gold-400/70">pts</span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {screen === 'lobby' && <Lobby viewer={viewer} onStart={startMatch} onOpenReplay={openReplay} />}
        {screen === 'table' && setup && (
          <TableView setup={setup} viewer={viewer} onExit={() => setScreen('lobby')} onPointsChange={(p) => setViewer((v) => ({ ...v, points: p }))} />
        )}
        {screen === 'replays' && <ReplayView matchId={replayMatchId} />}
        {screen === 'leaderboard' && <LeaderboardView />}
        {screen === 'stats' && <StatsView />}
      </main>
    </div>
  );
}

async function loadViewerPoints(): Promise<number> {
  const { supabase } = await import('@/lib/db');
  const v = loadViewer();
  const { data } = await supabase.from('viewers').select('points').eq('viewer_id', v.viewer_id).maybeSingle();
  return data?.points ?? 1000;
}

function NavBtn({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
        active ? 'bg-gold-400/15 text-gold-300' : 'text-stone-400 hover:text-cream'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export default App;
