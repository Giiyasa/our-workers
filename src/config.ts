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
export const TABLE_USER = "user";
export const TABLE_OTP = "otp";

/**
 * Tabel kode pemulihan perangkat.
 *
 * Baris dibuat bersama akun (di proses pembuatan akun, di luar worker ini)
 * dengan `machine_info` **NULL**. Kolom itu baru terisi saat kodenya dipakai
 * untuk memindahkan akun ke komputer lain; sejak saat itu isinya menjadi
 * sumber kebenaran perangkat akun tersebut (lihat lib/session.ts).
 */
export const TABLE_RECOVERY = "recovery_user";

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
// Auth: login, verifikasi OTP, dan token akses (POST /api/auth/*)
// ---------------------------------------------------------------------------
//
// Bentuk hash password yang disimpan di kolom `user.password_hash`:
//
//     sha256-v1$<salt 32 heksadesimal>$<sha256(salt + ":" + password) 64 heksadesimal>
//
// MD5 sengaja TIDAK dipakai untuk password. Alasannya ada di src/lib/auth.ts.
// Kalau nanti mau ganti algoritme, naikkan saja angka versinya (`sha256-v2$…`)
// — hash lama tetap bisa dibaca karena versinya ikut tersimpan.

/** Penanda versi hash password yang berlaku sekarang. */
export const PASSWORD_HASH_TAG = "sha256-v1";

/** Panjang salt password, dalam satuan byte acak (32 byte = 64 huruf). */
export const PASSWORD_SALT_BYTES = 16;

/** Panjang maksimum password yang diterima (karakter). */
export const MAX_PASSWORD_LENGTH = 200;

/** Panjang maksimum email yang diterima (karakter). */
export const MAX_EMAIL_LENGTH = 254;

/** Panjang maksimum `machine_info` yang diterima (byte). */
export const MAX_MACHINE_INFO_LENGTH = 8_000;

/** Umur kode OTP (detik). */
export const OTP_TTL_S = 300;

/**
 * Umur bawaan token akses (detik) — 7 hari.
 *
 * Aplikasi ini desktop: menutup aplikasi tidak boleh memaksa login ulang, jadi
 * masa berlakunya panjang. Yang membuat sesi tetap aman bukan masa berlakunya,
 * melainkan catatan sesi di server — logout (atau ganti password) langsung
 * mencabutnya, tanpa menunggu kadaluarsa.
 */
export const ACCESS_TOKEN_TTL_S = 7 * 86_400;

/**
 * Umur maksimum token akses yang boleh diminta client (7 hari, sama dengan
 * bawaan). Tidak ada alasan produk untuk sesi lebih panjang, dan batas ini yang
 * mencegah client meminta sesi abadi lewat header.
 */
export const ACCESS_TOKEN_MAX_TTL_S = ACCESS_TOKEN_TTL_S;

/** Panjang maksimum isi body request JSON (byte). */
export const MAX_BODY_BYTES = 16_384;

// ---------------------------------------------------------------------------
// Nama header khusus auth
// ---------------------------------------------------------------------------
//
// Dipakai supaya masa berlaku OTP dan token bisa diatur per-request saat
// pengembangan/uji tanpa mengubah kode — dan tanpa menyentuh file konfigurasi.
// Di produksi nilainya bisa dikunci lewat variabel lingkungan (ACCESS_TOKEN_TTL_S).

/** Header berisi jumlah digit kode OTP yang diminta (4-6, bawaan 4). */
export const OTP_DIGITS_HEADER = "x-otp-digits";

/** Header pilihan: minta kode OTP ikut dikembalikan di respons (hanya mode uji). */
export const OTP_RESPONSE_HEADER = "x-otp-code";

/** Header pilihan: minta umur token akses (detik). */
export const TOKEN_TTL_HEADER = "x-token-ttl-seconds";

/** Jumlah digit kode OTP bawaan (kolom `otp_code` bertipe int4). */
export const OTP_DIGITS_DEFAULT = 4;

/** Batas jumlah digit kode OTP yang dilayani. */
export const OTP_DIGITS_MIN = 4;
export const OTP_DIGITS_MAX = 6;

/** Umur minimum token akses yang boleh diminta (detik). */
export const ACCESS_TOKEN_MIN_TTL_S = 60;

/**
 * Rahasia pembuat token akses.
 *
 * WAJIB di-set di produksi: `wrangler secret put AUTH_SECRET`.
 * Nilai bawaan dipakai di mode pengembangan saja — health akan melaporkan
 * `authSecretTemporary: true` supaya tidak diam-diam ikut ke produksi.
 */
export const AUTH_SECRET_DEV = "dev-secret-JANGAN-DIPAKAI-DI-PRODUKSI";

/** Nama header yang membawa token akses. */
export const ACCESS_TOKEN_HEADER = "x-access-token";

// ---------------------------------------------------------------------------
// Catatan sesi di dalam kolom `user.machine_info`
// ---------------------------------------------------------------------------
//
// Constraint project: TIDAK menambah tabel/kolom. Padahal "token punya masa
// berlaku per user + force logout bila tidak valid" menuntut ada tempat
// menyimpan MASA BERLAKU itu di sisi server.
//
// Jalan keluarnya: kolom `machine_info` bertipe teks bebas, dan memang sudah
// dipakai untuk menyimpan keterangan komputer user yang dikirim FE setelah
// login. Jadi kolom itu dipakai sebagai wadah JSON berisi dua bagian:
//
//     { "sesi": { ...masa berlaku & sidik jari kredensial... }, "mesin": {...} }
//
// `sesi`  -> milik Worker (dibuat saat login, dipakai untuk memutuskan token
//            masih sah atau tidak)
// `mesin` -> milik FE (informasi komputer, ditulis lewat POST /api/auth/machine)
//
// Keduanya hidup berdampingan tanpa saling menimpa, dan tetap satu kolom.

/** Kunci catatan sesi di dalam `machine_info`. */
export const MACHINE_SESSION_KEY = "sesi";

/** Kunci informasi komputer (kiriman FE) di dalam `machine_info`. */
export const MACHINE_INFO_KEY = "mesin";

/**
 * Kunci daftar perangkat di dalam `machine_info`.
 *
 * SENGAJA dibuat sebagai kunci SAUDARA `sesi`, bukan isinya. Kalau `device_id`
 * dititipkan di dalam `sesi`, aturan "satu komputer" bocor lewat logout:
 * logout menghapus `sesi`, dan login berikutnya dari komputer lain akan
 * menemukan daftar perangkat kosong lalu mendaftarkannya. Yang dihapus saat
 * logout hanya `sesi`; `perangkat` bertahan.
 */
export const MACHINE_DEVICE_KEY = "perangkat";

/** Versi catatan sesi, supaya bentuk lama tetap bisa dibaca. */
export const MACHINE_SESSION_VERSION = 1;

/** Header berisi `user_id` saat FE hanya mengirim sidik jari (bukan token utuh). */
export const ACCESS_USER_HEADER = "x-user-id";

/**
 * Header berisi `device_id` komputer pemanggil.
 *
 * Wajib ada di SETIAP permintaan bersesi, bukan cuma saat login. Tanpa ini,
 * menyalin berkas sesi dari komputer A ke komputer B langsung membuka akun —
 * karena `MachineGuid` komputer B tidak pernah dibandingkan.
 */
export const DEVICE_ID_HEADER = "x-device-id";

/** Panjang maksimum `device_id` (karakter) — UUID MachineGuid ±36. */
export const MAX_DEVICE_ID_LENGTH = 128;

/** Panjang maksimum nama komputer `device_name` (karakter). */
export const MAX_DEVICE_NAME_LENGTH = 64;

/** Panjang minimum `device_id` yang diterima (karakter). */
export const MIN_DEVICE_ID_LENGTH = 8;

/** Header berisi nama komputer, dipakai kalau FE mengirimnya lewat header. */
export const DEVICE_NAME_HEADER = "x-device-name";

// ---------------------------------------------------------------------------
// Kode pemulihan perangkat (tabel `recovery_user`)
// ---------------------------------------------------------------------------

/** Maksimum percobaan kode pemulihan yang salah (per user, per kode). */
export const RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Jendela waktu batas percobaan kode pemulihan (detik).
 *
 * Kebijakannya: maksimum RECOVERY_MAX_ATTEMPTS percobaan salah per jendela ini,
 * dihitung per akun. Dipilih berbasis jendela, bukan "3 kali lalu kode mati",
 * karena worker TIDAK BOLEH mematikan baris `recovery_user` yang salah — kalau
 * kode salah 3 kali lalu barisnya ditandai `is_used`, pengguna yang cuma salah
 * ketik akan kehilangan kodenya dan harus minta baru ke admin.
 */
export const RECOVERY_ATTEMPT_WINDOW_S = 900;

/**
 * Penanda baris "percobaan kode pemulihan gagal" di tabel `otp`.
 *
 * Tabel `recovery_user` TIDAK bisa dipakai untuk penanda: `recovery_key`-nya
 * UNIQUE, jadi penanda dengan nilai tetap cuma bisa ada satu baris untuk
 * seluruh tabel. Tabel `otp` tidak punya batasan itu, dan polanya sudah
 * dipakai untuk percobaan OTP yang gagal (lihat OTP_FAILURE_MARK).
 *
 * Nilainya sengaja di bawah 1000: kode OTP sungguhan selalu 4-6 angka
 * (minimum 1000), jadi penanda tidak pernah bisa tertukar dengan kode asli —
 * lihat OTP_REAL_CODE_MIN.
 */
export const RECOVERY_FAILURE_MARK = 1;

/**
 * Nilai terkecil sebuah kode OTP sungguhan (4 angka, digit pertama bukan nol).
 *
 * Dipakai untuk memisahkan "kode asli" dari "baris penanda percobaan gagal"
 * saat menghitung kuota kirim: baris penanda bernilai 0 (percobaan OTP gagal)
 * dan 1 (percobaan kode pemulihan gagal). Tanpa pemisahan ini, percobaan kode
 * pemulihan yang gagal akan memakan jatah kirim OTP milik user.
 */
export const OTP_REAL_CODE_MIN = 1000;

// ---------------------------------------------------------------------------
// Batas laju kirim OTP
// ---------------------------------------------------------------------------

/** Jeda minimum antar-kode OTP untuk satu user (detik). */
export const OTP_MIN_INTERVAL_S = 60;

/** Jumlah maksimum kode OTP yang boleh diterbitkan per user dalam 1 jam. */
export const OTP_MAX_PER_HOUR = 5;

/** Maksimum percobaan verifikasi SATU kode OTP sebelum kode itu dimatikan. */
export const OTP_MAX_ATTEMPTS = 3;

/** Jendela pemeriksaan logout-paksa bila `updated_at` (detik). */
export const LOGOUT_CHECK_WINDOW_S = 10;

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
