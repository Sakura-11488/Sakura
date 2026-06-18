-- Keep user_profiles.follower_count in sync with creator_follows.

CREATE OR REPLACE FUNCTION public.sync_creator_follower_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_wallet text;
BEGIN
  target_wallet := COALESCE(NEW.creator_wallet, OLD.creator_wallet);

  UPDATE public.user_profiles
  SET follower_count = (
    SELECT count(*)::int
    FROM public.creator_follows
    WHERE creator_wallet = target_wallet
  )
  WHERE wallet_address = target_wallet;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS creator_follows_count_trigger ON public.creator_follows;

CREATE TRIGGER creator_follows_count_trigger
AFTER INSERT OR DELETE ON public.creator_follows
FOR EACH ROW
EXECUTE FUNCTION public.sync_creator_follower_count();

UPDATE public.user_profiles up
SET follower_count = sub.cnt
FROM (
  SELECT creator_wallet, count(*)::int AS cnt
  FROM public.creator_follows
  GROUP BY creator_wallet
) sub
WHERE up.wallet_address = sub.creator_wallet;
