-- Apply after FIXES_PATCH.sql. No existing auth/claim/Lua schema changes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.fixes_provider_accounts (
 account_id uuid PRIMARY KEY, label text NOT NULL DEFAULT '',
 session_encrypted bytea NOT NULL, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','needs_admin','disabled')),
 last_error_code text, blocked_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fixes_provider_usage (
 account_id uuid NOT NULL REFERENCES public.fixes_provider_accounts(account_id),
 usage_day date NOT NULL, download_count integer NOT NULL DEFAULT 0 CHECK(download_count BETWEEN 0 AND 24),
 PRIMARY KEY(account_id,usage_day)
);
CREATE TABLE IF NOT EXISTS public.fixes_provider_config (
 id integer PRIMARY KEY CHECK(id=1), download_hosts jsonb NOT NULL DEFAULT '[]',
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.fixes_provider_config(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
-- Legacy fixes_provider_session remains untouched for recovery/audit.
-- Login again to register the verified provider identity; never pool an unidentified duplicate.
ALTER TABLE public.fixes_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_provider_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fixes_provider_accounts,public.fixes_provider_usage,public.fixes_provider_config FROM PUBLIC,anon,authenticated;
COMMIT;
