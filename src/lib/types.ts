export type GameKind = 'liars_dice' | 'werewolf';
export type Persona = 'Cautious' | 'Bluffer' | 'Analyst' | 'Chaos';
export type PlayerKind = 'llm' | 'jev';

export interface SeatDef {
  seat: number;
  name: string;
  kind: PlayerKind;
  persona?: Persona;
}

export interface MatchEvent {
  t: number;
  actor: number; // -1 system
  type: string;
  payload: Record<string, unknown>;
  visible_to: number[] | null;
  latency_ms?: number | null;
  cost_usd?: number | null;
  forfeit?: boolean;
  table_talk?: string;
  private_reasoning?: string;
  raw_jev?: unknown;
}

export interface MatchRecord {
  id: string;
  game: GameKind;
  seats: SeatDef[];
  winner_seat: number | null;
  status: string;
  created_at?: string;
}

export interface ViewerState {
  viewer_id: string;
  nickname: string;
  points: number;
}

export const PERSONAS: Persona[] = ['Cautious', 'Bluffer', 'Analyst', 'Chaos'];

const NICKNAMES = ['Ana', 'Bo', 'Cy', 'Dee', 'Elf', 'Fox'];

export function loadViewer(): ViewerState {
  let viewerId = localStorage.getItem('viewer_id');
  if (!viewerId) {
    viewerId = crypto.randomUUID();
    localStorage.setItem('viewer_id', viewerId);
  }
  let nickname = localStorage.getItem('nickname');
  if (!nickname) {
    nickname = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)];
    localStorage.setItem('nickname', nickname);
  }
  return { viewer_id: viewerId, nickname, points: 1000 };
}

export function saveNickname(nickname: string) {
  localStorage.setItem('nickname', nickname);
}
