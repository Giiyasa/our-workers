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

// ---------------------------------------------------------------------------
// Gambar Steam (header_image) untuk GET /api/games
// ---------------------------------------------------------------------------

/** Endpoint appdetails Steam Store. */
export const STEAM_API_URL = "https://store.steampowered.com/api/appdetails";

/**
 * Negara & bahasa untuk appdetails. `cc` menentukan mata uang/harga;
 * `l` menentukan bahasa field teks. header_image tidak berubah karena ini,
 * tapi nilai tetap dikunci supaya respons bisa di-cache bersama-sama.
 */
export const STEAM_CC = "us";

/**
 * Batas jumlah permintaan ke Steam yang berjalan bersamaan.
 *
 * Tiap game = satu subrequest. Kalau semuanya dikirim serempak, Steam
 * cenderung membalas lambat/diam (respons menggantung) dan sebagian gambar
 * hilang. 8 cukup untuk membuat 25 game selesai dalam ±1 putaran sambil
 * tetap jauh dari batas subrequest Worker (50 per permintaan di paket gratis;
 * page_size maksimum 100 sudah di atas itu, jadi sebagian gambar bisa null
 * — lihat catatan di README).
 */
export const STEAM_FETCH_CONCURRENCY = 8;

/** Batas tunggu satu permintaan appdetails (ms). Lewat batas = tanpa gambar. */
export const STEAM_FETCH_TIMEOUT_MS = 3_000;

/** TTL cache tepi Cloudflare untuk respons appdetails (detik). */
export const STEAM_IMAGE_CACHE_TTL_S = 86_400;

/** Panjang maksimum URL header_image yang diterima. */
export const MAX_HEADER_IMAGE_LENGTH = 512;

/** appid di atas ini tidak masuk akal; langsung dilewati tanpa subrequest. */
export const STEAM_MAX_APP_ID = 4_294_967_295;

// ---------------------------------------------------------------------------
// Detail game Steam (GET /api/games/:game_id)
// ---------------------------------------------------------------------------

/**
 * Batas tunggu satu permintaan appdetails DETAIL (ms).
 *
 * Lebih longgar dari `STEAM_FETCH_TIMEOUT_MS` karena permintaan ini TIDAK
 * memakai `filters=basic`: responsnya ±30 KB (deskripsi panjang, screenshots,
 * requirements) dan Steam butuh waktu lebih untuk menyusunnya. Batasnya tetap
 * ada supaya satu game yang menggantung tidak menahan permintaan user.
 */
export const STEAM_DETAIL_TIMEOUT_MS = 10_000;

/**
 * TTL cache tepi Cloudflare untuk respons appdetails detail (detik).
 *
 * 24 jam: harga/deskripsi game praktis tidak berubah dalam sehari, dan ini yang
 * membuat permintaan `game_id` yang sama berikutnya tidak menembak Steam lagi.
 */
export const STEAM_DETAIL_CACHE_TTL_S = 86_400;

/** Panjang maksimum URL gambar (header/screenshot) yang diterima dari Steam. */
export const MAX_IMAGE_URL_LENGTH = 512;
