-- Run manually in Supabase SQL Editor before deploying the new backend.
-- Existing failures are not backfilled: only confirmed missing assets are flagged.
BEGIN;
ALTER TABLE public.game_lists
  ADD COLUMN IF NOT EXISTS is_unavailable_game boolean NOT NULL DEFAULT false;

-- New Lua assets added by the admin also reopen access automatically.
CREATE OR REPLACE FUNCTION public.reopen_game_with_lua_asset()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.lua_data IS NOT NULL AND octet_length(NEW.lua_data) > 0 THEN
    UPDATE public.game_lists SET is_unavailable_game = false
    WHERE app_id = NEW.game_id AND is_unavailable_game = true;
    UPDATE public.game_asset_jobs SET next_retry_at = NULL
    WHERE game_id = NEW.game_id AND status = 'not_found';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reopen_game_with_lua_asset ON public.game_assets;
CREATE TRIGGER reopen_game_with_lua_asset
AFTER INSERT OR UPDATE OF lua_data ON public.game_assets
FOR EACH ROW EXECUTE FUNCTION public.reopen_game_with_lua_asset();
COMMIT;

-- To reopen a game manually, run both statements together (replace the AppID):
-- BEGIN;
-- UPDATE public.game_lists SET is_unavailable_game = false WHERE app_id = 1245620;
-- UPDATE public.game_asset_jobs SET next_retry_at = NULL WHERE game_id = 1245620 AND status = 'not_found';
-- COMMIT;
