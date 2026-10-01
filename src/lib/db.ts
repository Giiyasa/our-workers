/**
 * Koneksi database: LANGSUNG ke Postgres Supabase (tanpa Hyperdrive).
 *
 * String koneksinya disimpan sebagai SECRET (bukan di file konfigurasi, bukan
 * di git): `wrangler secret put DIRECT_URL`.
 *
 * !! JALUR INI TIDAK TERENKRIPSI !!
 * Cloudflare Workers saat ini TIDAK BISA membuat TLS ke server Postgres.
 * Sudah diuji berulang kali, hasilnya selalu gagal:
 *
 *   - postgres.js  : "The options.rejectUnauthorized option is not implemented"
 *   - pg (node-pg) : error yang sama
 *   - connect({secureTransport:"on"})  -> "proxy request failed"
 *   - sock.startTls({expectedServerHostname}) -> "TLS Handshake Failed."
 *   - node:tls pada socket Workers      -> "options.rejectUnauthorized ... "
 *
 * Sebagai pembanding, TLS ke server lain (smtp.gmail.com:465) BERHASIL, jadi
 * ini batasan khusus jalur TLS-ke-Postgres, bukan berarti Worker tidak bisa
 * TLS sama sekali.
 *
 * AKIBATNYA: data (termasuk hash password, kode OTP) berjalan TANPA enkripsi
 * antara Cloudflare dan Supabase. Amannya: pakai kredensial yang hak aksesnya
 * dibatasi, dan/atau pindah ke Hyperdrive yang menyediakan TLS.
 *
 * CATATAN GAYA: seluruh nama fungsi, variabel, konstanta, dan kunci JSON
 * memakai bahasa Inggris. Komentar dan pesan error tetap bahasa Indonesia.
 */

import postgres from "postgres";

/** Tipe client database, dipakai modul rute lewat lib/types.ts. */
export type Sql = postgres.Sql;

/**
 * Buat client baru per-request. Worker tidak boleh menyimpan soket di
 * variabel global (dilarang runtime dan bocor antar-request).
 */
export function createDb(env: Env) {
	return postgres(env.DIRECT_URL, {
		// Worker dibatasi 6 koneksi bersamaan; sisakan ruang.
		max: 3,
		// Hemat satu round-trip kalau tipe array tidak dipakai.
		fetch_types: false,
		// Prepared statement butuh round-trip tambahan (Parse/Describe).
		// Jalur kita sudah rawan kena batas subrequest, jadi dimatikan.
		prepare: false,
		// EKSPLISIT: tanpa enkripsi. Lihat catatan di atas.
		// Jangan diubah jadi `true`: TLS ke Postgres dari Workers memang gagal,
		// dan kalaupun "jalan" ia bisa turun diam-diam ke tanpa enkripsi.
		ssl: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
}
