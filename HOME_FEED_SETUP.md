# Quality Home feed

Apply HOME_FEED_PATCH.sql once if missing; then apply supabase/HOME_QUALITY_PATCH.sql.
Deploy Worker; run node scripts/home-sync.mjs using existing WRITE_TOKEN.
No new ENV, Queue or Steam key needed for this pipeline.
Cron remains 0 */12 * * * (07:00 and 19:00 WIB). Edge cache 5 minutes.

Home sections: Trending Games, Top Rated, Pilihan Unggulan.
Trending: paid game in Steam Most Played, at least 1000 reviews and 80% positive.
Top Rated: paid game, at least 5000 reviews and 90% positive, confidence adjusted ranking.
Highlights: paid game, rating confidence and review volume; hero comes from this selection.
Only type=0 (game), positive purchase price, not free-to-play; unknown pricing excluded.
Top Rated is among bounded candidates, not an exhaustive Steam-wide leaderboard.

Each 12-hour run: one chart request, up to eight batches of 25 StoreBrowse GetItems.
Candidate pool: up to 100 chart games + 25 rotating catalog entries + previous quality snapshots, deduplicated/capped at 200.
No per-game HTTP requests or full-catalog review crawl. A once-per-run rotating catalog sample scans IDs only.
Only three snapshots, up to 25 entries each, stored in DB. Store metadata is transient.
Metadata/source failure retains the previous quality snapshot. Successful metadata with an empty qualified selection clears that section, preventing stale free games.
Old raw most_played snapshot is not displayed by the new endpoint. No random fallback.
Home no longer requests the additional 10-game catalog page or displays unfiltered recent games.
Catalog, Fixes and login unaffected. No production SQL/deploy executed by local verification.
