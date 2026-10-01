/**
 * Konstanta bersama untuk seluruh worker.
 *
 * Semua nilai yang berhubungan dengan skema database (nama tabel, kolom yang
 * diizinkan) dan batas-batas API dikumpulkan di sini supaya tidak tersebar di
 * banyak file.
 */

export const WORKER_NAME = "worker-toko";

/** Mode koneksi database, dilaporkan apa adanya oleh GET /api/health. */
export const DB_MODE = "langsung (tanpa Hyperdrive)";

/** Jalur langsung TIDAK terenkripsi — penjelasan panjang di lib/db.ts. */
export const DB_ENCRYPTED = false;

export const TABLE_GAME = "game_list";
export const TABLE_ASSET = "game_asset";

/** Rute /api/db/inspect cuma boleh membaca tabel ini, bukan seluruh skema. */
export const ALLOWED_TABLES = new Set([TABLE_GAME, TABLE_ASSET]);

// ---------------------------------------------------------------------------
// Daftar game (GET /api/games)
// ---------------------------------------------------------------------------

/** Jumlah baris per halaman kalau `?page_size=` tidak diisi. */
export const DEFAULT_PAGE_SIZE = 24;

/** Batas maksimum `?page_size=` sekali ambil. */
export const MAX_PAGE_SIZE = 100;

/** Halaman terjauh yang dilayani (`?page=`), supaya paging ekstrem ditolak. */
export const MAX_PAGE = 10_000;

/** Panjang maksimum kata kunci `?search=`. */
export const MAX_SEARCH_LENGTH = 100;

/** Batas jumlah nilai untuk filter multi-nilai (category/genre/tags). */
export const MAX_FILTER_VALUES = 50;

/** Panjang maksimum satu nilai filter. */
export const MAX_FILTER_LENGTH = 64;

/** Header yang membawa write token. */
export const WRITE_TOKEN_HEADER = "x-write-token";
