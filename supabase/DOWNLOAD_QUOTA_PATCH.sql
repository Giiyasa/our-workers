begin;

-- Provider calls and user downloads have independent counters.
-- Preserve usage already recorded; lowering a limit never resets usage.
alter table public.provider_key_usage alter column daily_limit set default 24;
update public.provider_key_usage set daily_limit = least(daily_limit, 24);

alter table public.user_download_daily_usage alter column daily_limit set default 25;
update public.user_download_daily_usage set daily_limit = least(daily_limit, 25);

-- Legacy fixes counter is retained; the Worker now uses the shared user counter.
alter table public.fixes_download_usage alter column download_limit set default 25;
update public.fixes_download_usage set download_limit = least(download_limit, 25);

comment on table public.user_download_daily_usage is
  'Shared Lua + fixes user quota: 25 per fixed 12-hour slot, 50 per day; 00-12 and 12-24 Asia/Jakarta. Polling does not count.';
comment on table public.provider_key_usage is
  'Hubcap: at most 24 upstream calls per account/key; provider stats determine its reset window. Independent of user quota.';

commit;
