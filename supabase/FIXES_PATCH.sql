-- Additive patch; does not change login, claim coupons or existing Lua assets.
BEGIN;
CREATE TABLE IF NOT EXISTS public.fixes_catalog (
 app_id bigint PRIMARY KEY CHECK(app_id > 0), name text NOT NULL,
 header_image text, tags jsonb NOT NULL DEFAULT '[]', fix_count integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true, synced_at timestamptz NOT NULL DEFAULT now(), details_synced_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.fixes_entries (
 fix_id text PRIMARY KEY, app_id bigint NOT NULL REFERENCES public.fixes_catalog(app_id),
 revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'), snapshot jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true, synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixes_entries_app_idx ON public.fixes_entries(app_id);
CREATE TABLE IF NOT EXISTS public.fixes_provider_session (
 id integer PRIMARY KEY CHECK(id=1), session_encrypted bytea NOT NULL,
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'ready',
 last_error_code text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fixes_package_jobs (
 fix_id text NOT NULL REFERENCES public.fixes_entries(fix_id), revision text NOT NULL,
 slot text NOT NULL CHECK(slot IN ('manifest','fix')),
 app_id bigint NOT NULL, filename text NOT NULL, status text NOT NULL DEFAULT 'processing'
 CHECK(status IN ('processing','ready','failed')),
 request_token uuid, lease_token uuid, lease_expires_at timestamptz, work_started_at timestamptz,
 next_retry_at timestamptz, error_code text, attempts integer NOT NULL DEFAULT 1,
 r2_object_key text, sha256 text, size_bytes bigint,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(fix_id,revision,slot)
);
CREATE TABLE IF NOT EXISTS public.fixes_download_usage (
 user_id bigint NOT NULL, usage_day date NOT NULL, session_slot integer NOT NULL CHECK(session_slot IN (0,1)),
 download_count integer NOT NULL DEFAULT 0, download_limit integer NOT NULL DEFAULT 50 CHECK(download_limit > 0),
 PRIMARY KEY(user_id,usage_day,session_slot)
);
-- Private server tables: application authentication is enforced by the Worker.
ALTER TABLE public.fixes_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_provider_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_package_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixes_download_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fixes_catalog,public.fixes_entries,public.fixes_provider_session,
 public.fixes_package_jobs,public.fixes_download_usage FROM PUBLIC,anon,authenticated;
COMMIT;
