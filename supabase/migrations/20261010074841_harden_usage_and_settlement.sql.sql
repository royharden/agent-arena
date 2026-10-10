/*
# Harden usage counters and settlement security

1. Summary
- Locks `usage_counters` so no client role (anon, authenticated) can read or write it.
  RLS stays enabled; the existing `anon_read_usage` SELECT policy is dropped and
  ALL privileges are revoked from anon and authenticated. Only the service role
  (used by edge functions) can access the table.
- Adds a `SECURITY INVOKER` SQL function `increment_usage(p_fn text, p_cap int)`
  that atomically increments the daily counter and returns true if the new call
  count is under the cap, false (no row) if the cap was already reached.
  Execute is revoked from PUBLIC, anon, authenticated and granted only to
  service_role, so only edge functions can call it.
- Drops `anon_update_viewers` on `viewers` and `anon_update_matches` on
  `matches`. Viewer point balances and match status changes now go exclusively
  through the `arena-api` edge function (service role), preventing clients from
  directly editing points or match results.

2. Security changes
- usage_counters: RLS on, zero policies, ALL revoked from anon + authenticated.
- New function `increment_usage`: SECURITY INVOKER, search_path=public,
  execute revoked from PUBLIC/anon/authenticated, granted to service_role.
- viewers: DROP POLICY anon_update_viewers (clients can no longer UPDATE).
- matches: DROP POLICY anon_update_matches (clients can no longer UPDATE).

3. Important notes
- The service role bypasses RLS, so edge functions can still read/write
  usage_counters and update viewers/matches via the service role key.
- `increment_usage` uses INSERT ... ON CONFLICT DO UPDATE with a WHERE clause
  on `calls < p_cap`, so the increment-and-cap-check is a single atomic
  statement — no race condition between read and write.
- If the cap is already reached, ON CONFLICT DO UPDATE matches zero rows
  (the WHERE fails), so the function returns NULL (no row). Callers treat
  NULL / false as "cap reached".
*/

-- 1. Lock usage_counters: drop the only policy, revoke all from client roles
DROP POLICY IF EXISTS "anon_read_usage" ON usage_counters;
REVOKE ALL ON usage_counters FROM anon, authenticated;

-- 2. Create increment_usage as a SECURITY INVOKER function
CREATE OR REPLACE FUNCTION increment_usage(p_fn text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO usage_counters (day, fn, calls)
  VALUES ((now() AT TIME ZONE 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = usage_counters.calls + 1
  WHERE usage_counters.calls < p_cap
  RETURNING true;
$$;

-- Revoke execute from everyone, then grant only to service_role
REVOKE EXECUTE ON FUNCTION increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(text, int) TO service_role;

-- 3. Drop client-write policies on viewers and matches
DROP POLICY IF EXISTS "anon_update_viewers" ON viewers;
DROP POLICY IF EXISTS "anon_update_matches" ON matches;
