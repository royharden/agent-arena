/*
# Create Agent Arena schema

1. New Tables
- `matches` — one row per played match
  - `id` (uuid, primary key, default gen_random_uuid())
  - `game` (text, not null: 'liars_dice' | 'werewolf')
  - `seats` (jsonb, not null: [{seat, name, kind, persona, model}...])
  - `winner_seat` (int, nullable: seat index of winner)
  - `status` (text, not null, default 'in_progress': 'in_progress' | 'complete')
  - `created_at` (timestamptz, default now())
- `events` — one row per engine event, drives live view + replays
  - `id` (uuid, primary key, default gen_random_uuid())
  - `match_id` (uuid, not null, fk -> matches.id on delete cascade)
  - `seq` (int, not null: 0-based ordering within a match)
  - `actor` (int, not null: seat index, -1 = system/referee)
  - `type` (text, not null: 'bid' | 'call_liar' | 'statement' | 'vote' | ...)
  - `payload` (jsonb, not null)
  - `visible_to` (int[], nullable: null = everyone)
  - `latency_ms` (int, nullable: AI decision latency)
  - `cost_usd` (numeric, nullable: Jev cost)
- `ratings` — Elo per player_type per game
  - `player_type` (text, not null)
  - `game` (text, not null)
  - `elo` (numeric, not null, default 1200)
  - `games` (int, not null, default 0)
  - primary key (player_type, game)
- `bets` — viewer wagers on a seat
  - `id` (uuid, primary key, default gen_random_uuid())
  - `match_id` (uuid, not null, fk -> matches.id on delete cascade)
  - `viewer_id` (text, not null: random client id)
  - `nickname` (text, not null)
  - `seat` (int, not null)
  - `stake` (int, not null: points wagered)
  - `payout` (int, nullable: settled payout, null = pending)
- `viewers` — fake points balance per viewer
  - `viewer_id` (text, primary key)
  - `nickname` (text, not null)
  - `points` (int, not null, default 1000)
- `usage_counters` — daily call caps per function
  - `day` (date, not null: UTC day)
  - `fn` (text, not null: edge function name)
  - `calls` (int, not null, default 0)
  - primary key (day, fn)

2. Security
- RLS enabled on every table.
- Permissive anon reads (public spectating, no auth in this app).
- `viewers`, `bets`, `matches` allow anon insert/update for the client flow.
- `ratings` and `events`: reads only from anon — all writes go through the
  `arena-api` edge function which uses the service role and bypasses RLS.

3. Notes
- No auth flows: single-tenant, viewer identity is a localStorage id.
- Bet settlement and ratings updates are server-side only (arena-api).
- usage_counters row is upserted with ON CONFLICT increment; cap logic lives
  in the edge functions that increment it.
*/

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  seats jsonb NOT NULL,
  winner_seat int,
  status text NOT NULL DEFAULT 'in_progress',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq int NOT NULL,
  actor int NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  visible_to int[],
  latency_ms int,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ratings (
  player_type text NOT NULL,
  game text NOT NULL,
  elo numeric NOT NULL DEFAULT 1200,
  games int NOT NULL DEFAULT 0,
  PRIMARY KEY (player_type, game)
);

CREATE TABLE IF NOT EXISTS bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  viewer_id text NOT NULL,
  nickname text NOT NULL,
  seat int NOT NULL,
  stake int NOT NULL,
  payout int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS viewers (
  viewer_id text PRIMARY KEY,
  nickname text NOT NULL,
  points int NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

CREATE INDEX IF NOT EXISTS idx_events_match_seq ON events (match_id, seq);
CREATE INDEX IF NOT EXISTS idx_bets_match ON bets (match_id);

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_matches" ON matches;
CREATE POLICY "anon_read_matches" ON matches FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_matches" ON matches;
CREATE POLICY "anon_insert_matches" ON matches FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_matches" ON matches;
CREATE POLICY "anon_update_matches" ON matches FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_events" ON events;
CREATE POLICY "anon_read_events" ON events FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_read_ratings" ON ratings;
CREATE POLICY "anon_read_ratings" ON ratings FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_read_bets" ON bets;
CREATE POLICY "anon_read_bets" ON bets FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_bets" ON bets;
CREATE POLICY "anon_insert_bets" ON bets FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_viewers" ON viewers;
CREATE POLICY "anon_read_viewers" ON viewers FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_viewers" ON viewers;
CREATE POLICY "anon_insert_viewers" ON viewers FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_viewers" ON viewers;
CREATE POLICY "anon_update_viewers" ON viewers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_usage" ON usage_counters;
CREATE POLICY "anon_read_usage" ON usage_counters FOR SELECT TO anon, authenticated USING (true);
