/*
# Create deduct_points helper function

1. Summary
- Adds a SECURITY INVOKER SQL function `deduct_points(p_viewer_id text, p_amount int)`
  that atomically deducts points from a viewer only if they have enough.
  Returns the new balance on success, or NULL if insufficient funds.
- This closes the race condition in place_bet where two concurrent bets
  could both pass the balance check and overdraw the viewer's points.

2. Security
- SECURITY INVOKER, search_path = public.
- Execute revoked from PUBLIC, anon, authenticated; granted to service_role.
- Only the arena-api edge function (service role) can call it.
*/

CREATE OR REPLACE FUNCTION deduct_points(p_viewer_id text, p_amount int)
RETURNS int
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE viewers
  SET points = points - p_amount
  WHERE viewer_id = p_viewer_id AND points >= p_amount
  RETURNING points;
$$;

REVOKE EXECUTE ON FUNCTION deduct_points(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION deduct_points(text, int) TO service_role;
