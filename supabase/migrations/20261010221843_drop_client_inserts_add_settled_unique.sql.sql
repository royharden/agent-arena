/*
# Drop client insert policies and add settled-event uniqueness

1. Summary
- Drops INSERT policies on `bets`, `viewers`, and `matches` so clients
  (anon/authenticated) can no longer create rows directly. All inserts now
  go through the `arena-api` edge function using the service role key.
- Adds a unique partial index `events_one_settled` on `events(match_id)`
  filtered to `type = 'settled'`, so the database itself enforces that at
  most one settlement sentinel can exist per match. This closes the
  double-settle race: if two concurrent settle requests both pass the
  check-then-insert window, the second INSERT fails with a unique
  violation, which the edge function returns as 409 already_settled.

2. Security changes
- bets: DROP POLICY anon_insert_bets (clients can no longer INSERT).
- viewers: DROP POLICY anon_insert_viewers (clients can no longer INSERT).
- matches: DROP POLICY anon_insert_matches (clients can no longer INSERT).
- New unique partial index on events(match_id) WHERE type = 'settled'.

3. Important notes
- The service role bypasses RLS, so arena-api can still insert into all
  three tables using the service role key.
- SELECT policies on these tables remain, so clients can still read
  matches, bets, and viewers.
- The unique index is safe to re-run: CREATE UNIQUE INDEX IF NOT EXISTS.
*/

DROP POLICY IF EXISTS "anon_insert_bets" ON bets;
DROP POLICY IF EXISTS "anon_insert_viewers" ON viewers;
DROP POLICY IF EXISTS "anon_insert_matches" ON matches;

CREATE UNIQUE INDEX IF NOT EXISTS events_one_settled
  ON events (match_id)
  WHERE type = 'settled';
