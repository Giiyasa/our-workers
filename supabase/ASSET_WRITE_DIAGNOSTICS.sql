-- READ ONLY: run in Supabase SQL Editor. No payloads or credentials are returned.
-- Current size and state for the reported AppID.
SELECT game_id, octet_length(lua_data) AS encrypted_lua_bytes, encryption_version
FROM public.game_assets WHERE game_id = 1222670;
SELECT game_id, status, error_code, error_message, attempts, updated_at, next_retry_at
FROM public.game_asset_jobs WHERE game_id = 1222670;

-- Active triggers and their exact definitions (including custom audit functions).
SELECT c.relname AS table_name, t.tgname, t.tgenabled,
       pg_get_triggerdef(t.oid) AS trigger_definition,
       pg_get_functiondef(t.tgfoid) AS function_definition
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND c.relname IN ('game_assets', 'game_asset_jobs', 'game_lists');

-- Column types, defaults and constraints; no write simulation on production.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_schema='public' AND table_name='game_assets';
SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
WHERE conrelid = 'public.game_assets'::regclass;
SHOW statement_timeout;
SHOW lock_timeout;
SHOW idle_in_transaction_session_timeout;
