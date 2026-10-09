# Home feed

Apply supabase/HOME_FEED_PATCH.sql in the existing database before deploying Worker.
Cron: 0 */12 * * * (00:00 and 12:00 UTC / 07:00 and 19:00 WIB).
No new Queue. Optional STEAM_API_KEY secret can be used for monthly releases. Most Played anonymous Steam access verified locally.
Initial refresh: node scripts/home-sync.mjs (reuses .dev.vars WRITE_TOKEN). Also POST /api/admin/home/sync using existing X-Write-Token.
Read: GET /api/curated. Edge cache 5 minutes. Frontend query cache 1 hour.
Two snapshots, maximum 25 entries each. Metadata remains in game_lists.
Most Played considers up to 100 Steam candidates and stores only 25 catalog matches.
Monthly releases request the previous completed UTC month, include_dlc=false.
The current live monthly response was empty; this section is hidden until Steam supplies valid matching data. No old release list is fabricated.
Each section retains its last successful snapshot on source failure/empty data/no catalog match.
Apply SQL, deploy Worker, build frontend/native app. No production deployment or SQL execution performed by this change.
