/*
# Usage counter: atomic SECURITY DEFINER increment returning the call count

1. Summary
- Adds `increment_usage_counter(p_fn text) RETURNS integer`, a SECURITY DEFINER
  SQL function with `SET search_path = public`. It atomically increments
  today's (UTC) counter for `p_fn` with INSERT ... ON CONFLICT DO UPDATE ...
  RETURNING and returns the new call count. The edge functions (`jev`,
  `llm-player`) call it right before every paid upstream request and compare
  the count to their daily limit (200, overridable with the DAILY_CALL_LIMIT
  secret). Any RPC error, NULL or non-integer result is treated as over the
  limit (fail closed).
- Drops the old `increment_usage(text, int)` (SECURITY INVOKER, boolean) so
  there is a single increment path.

2. Security
- usage_counters: RLS stays on; no anon/authenticated policies; ALL privileges
  revoked from anon and authenticated (re-asserted here, idempotent).
- increment_usage_counter: EXECUTE revoked from PUBLIC, anon, authenticated;
  granted only to service_role.
*/

DROP POLICY IF EXISTS "anon_read_usage" ON usage_counters;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION increment_usage_counter(p_fn text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO usage_counters (day, fn, calls)
  VALUES ((now() AT TIME ZONE 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage_counter(text) TO service_role;

DROP FUNCTION IF EXISTS increment_usage(text, int);
