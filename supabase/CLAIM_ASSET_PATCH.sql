-- Jalankan manual di Supabase SETELAH migration game_asset_jobs yang sudah ada.
-- Tidak menyimpan API key/master key dan tidak mengubah data invoice lama.
begin;

alter table public.game_asset_jobs
    add column if not exists request_token uuid,
    add column if not exists work_started_at timestamptz,
    add column if not exists r2_object_key text,
    add column if not exists next_retry_at timestamptz,
    add column if not exists error_code text;

create table if not exists public.provider_key_usage (
    provider_key_id text primary key,
    enabled boolean not null default true,
    daily_usage_count integer not null default 0 check (daily_usage_count >= 0),
    daily_limit integer not null default 25 check (daily_limit > 0),
    stats_check_threshold integer not null default 22 check (stats_check_threshold > 0),
    stats_checked_at timestamptz,
    last_reserved_at timestamptz,
    updated_at timestamptz not null default now()
);
alter table public.provider_key_usage
    add column if not exists in_flight_count integer not null default 0 check (in_flight_count >= 0),
    add column if not exists last_provider_daily_usage integer,
    add column if not exists blocked_until timestamptz,
    add column if not exists stats_token uuid,
    add column if not exists stats_lease_until timestamptz;

create table if not exists public.provider_download_reservations (
    reservation_id uuid primary key,
    provider_key_id text not null references public.provider_key_usage(provider_key_id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists provider_download_reservations_key_idx on public.provider_download_reservations(provider_key_id);

create table if not exists public.user_download_daily_usage (
    user_id bigint not null references public."user"(user_id) on delete cascade,
    usage_day date not null,
    session_slot smallint not null check (session_slot in (0, 1)),
    download_count integer not null default 0 check (download_count >= 0),
    daily_limit integer not null default 50 check (daily_limit > 0),
    updated_at timestamptz not null default now(),
    primary key (user_id, usage_day, session_slot)
);

-- Mendukung jika versi counter per hari lama sudah pernah dijalankan.
do $$
declare old_pk text;
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'user_download_daily_usage' and column_name = 'session_slot') then
        alter table public.user_download_daily_usage add column session_slot smallint not null default 0
            check (session_slot in (0, 1));
        select conname into old_pk from pg_constraint
            where conrelid = 'public.user_download_daily_usage'::regclass and contype = 'p';
        if old_pk is not null then
            execute format('alter table public.user_download_daily_usage drop constraint %I', old_pk);
        end if;
        alter table public.user_download_daily_usage add primary key (user_id, usage_day, session_slot);
        -- Counter lama tidak punya informasi jam; pertahankan secara konservatif di kedua sesi.
        insert into public.user_download_daily_usage (user_id, usage_day, session_slot, download_count, daily_limit)
            select user_id, usage_day, 1, download_count, daily_limit from public.user_download_daily_usage where session_slot = 0
            on conflict do nothing;
        alter table public.user_download_daily_usage alter column session_slot drop default;
    end if;
end $$;

alter table public.provider_key_usage enable row level security;
alter table public.provider_download_reservations enable row level security;
alter table public.user_download_daily_usage enable row level security;
revoke all on public.provider_key_usage, public.provider_download_reservations, public.user_download_daily_usage from anon, authenticated;

comment on table public.provider_key_usage is 'Counter konservatif + reservasi provider 3. Sinkronkan/reset mengikuti daily_usage dari stats provider, dengan memperhitungkan request berjalan.';
comment on table public.user_download_daily_usage is '50 unduhan per user per sesi tetap: 00-12 dan 12-24 Asia/Jakarta. Polling tidak dihitung.';

commit;
