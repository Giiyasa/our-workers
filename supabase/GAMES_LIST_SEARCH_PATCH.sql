-- ============================================================================
-- GAMES_LIST_SEARCH_PATCH.sql
-- ============================================================================
-- Status: DRAFT - BELUM dijalankan. Jalankan manual di Supabase SQL Editor
-- setelah kolom nyata dikonfirmasi.
--
-- Tujuan: percepat GET /api/games (katalog +-182 ribu baris) dan bikin
-- pencarian tahan terhadap kebiasaan penulisan orang:
--
--   yang ada di DB              yang diketik orang
--   "The Witcher 3: Wild Hunt"  "witcher 3", "witcher3", "witcher", "wticher3"
--   "Marvel's Spider-Man"       "spiderman", "spider-man", "spider an"
--
-- Tiga hal yang dipasang:
--   1. kolom generated `search_key` = nama dinormalisasi [a-z0-9]
--   2. index untuk pencarian, urutan rilis, dan filter array
--   3. ekstensi pg_trgm + index GIN-nya (toleransi typo)
--
-- SETELAH SQL INI DIJALANKAN:
--   buka src/config.ts, ubah SEARCH_USE_NORMALIZED_KEY menjadi true, lalu
--   deploy. Selama flag itu false, rute tetap memakai `name ilike` biasa dan
--   kolom `search_key` tidak pernah dirujuk - jadi aman dijalankan kapan saja.
-- ============================================================================

-- 1. Ekstensi trigram (untuk `%` kemiripan + index GIN di bawah).
create extension if not exists pg_trgm;

-- 1b. Ekstensi jarak edit (lapis 2 pencarian: typo kata utuh).
--     "wticher" -> "watcher" (jarak edit 2). Kalau ekstensi ini belum
--     dipasang, rute katalog otomatis memakai pencarian TANPA lapis ini
--     (lihat src/lib/fuzzy.ts) — tidak error, hanya tidak menangkap typo
--     kata utuh sampai ekstensinya terpasang.
create extension if not exists fuzzystrmatch;

-- 2. Kolom kunci pencarian.
--
--    WAJIB SAMA dengan fungsi normalizeSearchKey() di src/lib/search.ts.
--    Kalau salah satu diubah, ubah KEDUANYA, kalau tidak pencarian
--    diam-diam berhenti cocok.
--
--    `generated always ... stored` -> diisi Postgres otomatis dari `name`,
--    tidak perlu backfill manual, ikut ter-update saat nama diubah.
alter table game_lists
  add column if not exists search_key text
  generated always as (
    regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', '', 'g')
  ) stored;

-- 3. Index trigram pada kunci pencarian.
--    Dipakai oleh:  search_key LIKE '%kata%'  dan  search_key % 'kata'
create index if not exists game_lists_search_trgm_idx
  on game_lists using gin (search_key gin_trgm_ops);

-- 4. Index urutan default (terbaru rilis dulu).
--    Dipakai oleh:  order by release_date desc nulls last, id
create index if not exists game_lists_release_idx
  on game_lists (release_date desc nulls last, id);

-- 5. Index filter genre / category (kolom text[]).
--    Dipakai oleh:  'Action' = any(genre)
create index if not exists game_lists_genre_gin
  on game_lists using gin (genre);
create index if not exists game_lists_categories_gin
  on game_lists using gin (categories);

-- 6. Perbarui statistik supaya reltuples (dipakai untuk `total` tanpa filter)
--    langsung akurat setelah index dipasang.
analyze game_lists;

-- ============================================================================
-- OPSIONAL - hanya kalau katalog sering dijelajah sampai halaman dalam.
-- Mengganti OFFSET besar (baca-buang) dengan keyset. MENGUBAH bentuk UI
-- paginasi (tanpa nomor halaman), jadi kerjakan belakangan kalau perlu.
-- ============================================================================
-- create index if not exists game_lists_release_keyset_idx
--   on game_lists (release_date desc nulls last, id desc);
