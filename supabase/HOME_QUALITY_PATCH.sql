-- Apply after HOME_FEED_PATCH.sql. Existing snapshots preserved.
alter table public.home_feed drop constraint if exists home_feed_section_check;
alter table public.home_feed add constraint home_feed_section_check
 check(section in ('most_played','popular_new_releases','trending','top_rated','highlights'));
