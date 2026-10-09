-- Small snapshots only; metadata remains in game_lists.
create table if not exists public.home_feed (
 section text primary key check (section in ('most_played','popular_new_releases')),
 entries jsonb not null check (jsonb_typeof(entries) = 'array' and jsonb_array_length(entries) <= 25),
 source_period text,
 updated_at timestamptz not null default now()
);
alter table public.home_feed enable row level security;
revoke all on public.home_feed from anon, authenticated;
