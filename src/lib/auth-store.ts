/**
 * Pekerjaan database untuk rute auth (tabel `user` + `otp`).
 *
 * Rute menyusun urutan dan bentuk respons; seluruh SQL-nya ada di sini supaya
 * janji "tidak ada tabel/kolom baru" gampang diperiksa: file ini cuma
 * menyentuh `user` dan `otp`.
 *
 * ============================================================================
 * KHUSUS TABEL `otp` — dua hal yang dipakai terus di bawah
 * ============================================================================
 * 1. SELALU cuma ada SATU kode hidup per user. Setiap kode baru menutup semua
 *    kode lama (`is_used = true`). Tanpa itu, kode lama yang belum kadaluarsa
 *    tetap bisa dipakai — dan "kode terakhir" jadi ambigu.
 *
 * 2. `otp.otp_code` bertipe int4 dan kita TIDAK menambah kolom. Maka percobaan
 *    verifikasi yang GAGAL tidak punya tempat menyimpan penghitungnya. Jalan
 *    keluarnya: satu percobaan gagal = satu baris penanda
 *    (`otp_code = 0`, `is_used = true`, `expired_at = now()`).
 *    Angka 0 tidak pernah dipakai kode sungguhan (generateOtpCode selalu
 *    menghasilkan 4 digit penuh), jadi baris bertanda 0 aman dibedakan dari
 *    kode sungguhan, dan bisa dihitung:
 *
 *        percobaan gagal = banyak baris otp_code = 0 milik user itu yang
 *                          dibuat SETELAH kode hidup terakhir terbit
 *
 *    Ada satu penanda lagi dari fitur pemulihan perangkat: percobaan kode
 *    pemulihan yang gagal juga dicatat di tabel ini (lihat lib/auth-recovery.ts),
 *    dengan nilai RECOVERY_FAILURE_MARK = 1. Tabel `recovery_user` tidak bisa
 *    menampungnya karena `recovery_key`-nya UNIQUE.
 *
 *    Kedua penanda (0 dan 1) sama-sama di bawah OTP_REAL_CODE_MIN, dan itulah
 *    yang dipakai membedakannya dari kode sungguhan. Batas laju pengiriman
 *    menghitung HANYA kode sungguhan (`otp_code >= OTP_REAL_CODE_MIN`), supaya
 *    tebakan yang gagal — OTP maupun kode pemulihan — tidak "menghabiskan
 *    kuota kirim" milik user.
 *
 * CATATAN TIPE (diuji terhadap Postgres sungguhan, bukan dugaan):
 *   user_id / otp.id  -> int8  -> driver mengembalikan STRING ("12")
 *   otp.otp_code      -> int4  -> number
 *   timestamptz       -> Date
 *   interval          -> string detik, mis. "300.000000"
 */

import {
	OTP_MAX_PER_HOUR,
	OTP_MIN_INTERVAL_S,
	OTP_REAL_CODE_MIN,
	OTP_TTL_S,
	TABLE_OTP,
	TABLE_USER,
} from "../config";
import { readSeconds } from "./auth-time";
import type { Sql } from "./db";

/** Penanda baris "percobaan verifikasi gagal" di tabel `otp`. */
export const OTP_FAILURE_MARK = 0;

/** Satu baris `user` yang dibutuhkan auth — TANPA `password_hash` mentah. */
export interface AuthUserRow {
	user_id: string;
	email: string;
	password_hash: string | null;
	access_role_code: number;
	access_role_name: string;
	is_verified: boolean;
	free_claim_game: number;
	machine_info: string | null;
	created_at: Date;
	updated_at: Date;
}

/** Kolom yang diambil untuk auth. Sengaja eksplisit, bukan `select *`. */
const USER_COLUMNS = (sql: Sql) => sql`
	user_id, email, password_hash, access_role_code, access_role_name,
	is_verified, free_claim_game, machine_info, created_at, updated_at
`;

/** Bentuk user yang dikirim ke client: tanpa password_hash, tanpa machine_info. */
export function shapeUser(row: AuthUserRow) {
	return {
		user_id: String(row.user_id),
		email: row.email,
		is_verified: row.is_verified,
		access_role_code: row.access_role_code,
		access_role_name: row.access_role_name,
		free_claim_game: row.free_claim_game,
		created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
		// machine_info tidak ikut: isinya keterangan komputer user, bukan untuk
		// ditampilkan. Rutenya sendiri yang mengabarkan "sudah terpasang".
		machine_info_terpasang: Boolean(row.machine_info),
	};
}

/** Cari user berdasarkan email. Email disamakan huruf kecil (lihat normalizeEmail). */
export async function findUserByEmail(sql: Sql, email: string): Promise<AuthUserRow | null> {
	const rows = await sql<AuthUserRow[]>`
		select ${USER_COLUMNS(sql)} from ${sql(TABLE_USER)}
		where lower(email) = ${email}
		limit 1
	`;
	return rows[0] ?? null;
}

/** Cari user berdasarkan `user_id` (datang dari token, selalu string). */
export async function findUserById(sql: Sql, userId: string): Promise<AuthUserRow | null> {
	const rows = await sql<AuthUserRow[]>`
		select ${USER_COLUMNS(sql)} from ${sql(TABLE_USER)}
		where user_id = ${userId}::int8
		limit 1
	`;
	return rows[0] ?? null;
}

/**
 * Waktu sekarang menurut DATABASE.
 *
 * Sengaja dari `now()` database, bukan `Date.now()` Worker atau jam komputer
 * user: masa berlaku OTP dan token harus dinilai dengan jam yang sama dengan
 * jam yang menulis datanya.
 */
export async function readDbNow(sql: Sql): Promise<Date> {
	const rows = await sql<{ now: Date }[]>`select now() as now`;
	return rows[0]?.now ?? new Date();
}

/** Ringkasan aktivitas OTP seorang user, dihitung dari tabel `otp` saja. */
export interface OtpActivity {
	/** Jumlah kode sungguhan yang diterbitkan dalam 1 jam terakhir. */
	kodePerJam: number;
	/** Detik sejak kode sungguhan terakhir diterbitkan (null = belum pernah). */
	jedaDetik: number | null;
}

export async function readOtpActivity(sql: Sql, userId: string): Promise<OtpActivity> {
	const rows = await sql<{ kode_per_jam: number; jeda_detik: unknown }[]>`
		select
			(select count(*)::int from ${sql(TABLE_OTP)}
				where user_id = ${userId}::int8
				  and otp_code >= ${OTP_REAL_CODE_MIN}
				  and created_at > now() - interval '1 hour') as kode_per_jam,
			(select extract(epoch from (now() - max(created_at))) from ${sql(TABLE_OTP)}
				where user_id = ${userId}::int8
				  and otp_code >= ${OTP_REAL_CODE_MIN}) as jeda_detik
	`;
	const row = rows[0];
	return {
		kodePerJam: Number(row?.kode_per_jam ?? 0),
		jedaDetik: readSeconds(row?.jeda_detik),
	};
}

export interface OtpIssueResult {
	ok: boolean;
	/** Alasan penolakan kalau `ok: false`. */
	reason: "baru-saja" | "terlalu-sering" | null;
	/** Detik sampai boleh minta kode lagi. */
	tungguDetik: number;
	/** Masa berlaku kode (detik). */
	berlakuDetik: number;
}

/**
 * Terbitkan kode OTP baru untuk seorang user.
 *
 * Urutannya: baca aktivitas (dari tabel `otp` sendiri, tanpa penghitung di
 * tempat lain) → tolak kalau kode terakhir masih terlalu baru atau kuota per
 * jam habis → tutup semua kode lama → simpan kode baru.
 *
 * Kode MENTAH dikembalikan ke pemanggil (untuk dikirim lewat email); yang
 * tersimpan di database hanya angka di kolom `otp_code`, sesuai bentuk kolom
 * yang sudah ada. Kode dikirim sebagai teks lalu di-cast di SQL supaya nol di
 * depan tidak hilang saat masuk ke kolom int4.
 */
export async function issueOtp(sql: Sql, userId: string, code: string): Promise<OtpIssueResult> {
	const activity = await readOtpActivity(sql, userId);

	if (activity.jedaDetik !== null && activity.jedaDetik < OTP_MIN_INTERVAL_S) {
		return {
			ok: false,
			reason: "baru-saja",
			tungguDetik: Math.ceil(OTP_MIN_INTERVAL_S - activity.jedaDetik),
			berlakuDetik: OTP_TTL_S,
		};
	}
	if (activity.kodePerJam >= OTP_MAX_PER_HOUR) {
		return { ok: false, reason: "terlalu-sering", tungguDetik: 3600, berlakuDetik: 0 };
	}

	// Satu kode hidup per user: kode lama ditutup lebih dulu.
	await sql`
		update ${sql(TABLE_OTP)} set is_used = true, updated_at = now()
		where user_id = ${userId}::int8 and is_used = false
	`;

	await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${code}::int4, false,
			 now() + ${OTP_TTL_S} * interval '1 second', now(), now())
	`;

	return { ok: true, reason: null, tungguDetik: 0, berlakuDetik: OTP_TTL_S };
}

// ---------------------------------------------------------------------------
// Verifikasi OTP
// ---------------------------------------------------------------------------

export interface LiveOtpRow {
	id: string;
	otp_code: number;
	/** Sisa masa berlaku (detik). Bisa negatif kalau sudah lewat. */
	sisaDetik: number | null;
}

/** Kode hidup (belum dipakai) terbaru milik seorang user. */
export async function findLiveOtp(sql: Sql, userId: string): Promise<LiveOtpRow | null> {
	const rows = await sql<{ id: string; otp_code: number; sisa_detik: unknown }[]>`
		select id, otp_code, extract(epoch from (expired_at - now())) as sisa_detik
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8 and is_used = false
		order by created_at desc
		limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	return { id: String(row.id), otp_code: Number(row.otp_code), sisaDetik: readSeconds(row.sisa_detik) };
}

/** Catat satu percobaan verifikasi yang gagal (baris penanda `otp_code = 0`). */
export async function recordFailedOtpAttempt(sql: Sql, userId: string): Promise<void> {
	await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${OTP_FAILURE_MARK}, true, now(), now(), now())
	`;
}

/**
 * Hitung percobaan gagal SETELAH kode hidup terakhir terbit.
 * Dipakai untuk memutuskan kapan kode dimatikan.
 */
export async function countFailedOtpAttempts(sql: Sql, userId: string, liveOtpId: string): Promise<number> {
	const rows = await sql<{ jumlah: number }[]>`
		select count(*)::int as jumlah from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${OTP_FAILURE_MARK}
			and created_at >= (select created_at from ${sql(TABLE_OTP)} where id = ${liveOtpId}::int8)
	`;
	return Number(rows[0]?.jumlah ?? 0);
}

/** Tutup seluruh kode hidup seorang user. */
export async function closeAllOtps(sql: Sql, userId: string): Promise<void> {
	await sql`
		update ${sql(TABLE_OTP)} set is_used = true, updated_at = now()
		where user_id = ${userId}::int8 and is_used = false
	`;
}

/** Tutup SATU kode (dipakai kalau percobaan salah sudah kelewat batas). */
export async function closeOtp(sql: Sql, otpId: string): Promise<void> {
	await sql`
		update ${sql(TABLE_OTP)} set is_used = true, updated_at = now()
		where id = ${otpId}::int8
	`;
}

// ---------------------------------------------------------------------------
// Perubahan pada tabel `user`
// ---------------------------------------------------------------------------

/** Set `is_verified = true`. Mengembalikan false kalau baris user tak ada. */
export async function markVerified(sql: Sql, userId: string): Promise<boolean> {
	const rows = await sql`
		update ${sql(TABLE_USER)} set is_verified = true, updated_at = now()
		where user_id = ${userId}::int8
		returning user_id
	`;
	return rows.length > 0;
}

/** Simpan keterangan komputer user. Isi apa pun (teks/JSON) disimpan apa adanya. */
export async function saveMachineInfo(sql: Sql, userId: string, machineInfo: string): Promise<boolean> {
	const rows = await sql`
		update ${sql(TABLE_USER)} set machine_info = ${machineInfo}, updated_at = now()
		where user_id = ${userId}::int8
		returning user_id
	`;
	return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Catatan sesi (kolom `user.machine_info`)
// ---------------------------------------------------------------------------
//
// Masa berlaku token disimpan di kolom yang sudah ada — lihat lib/session.ts
// untuk alasan dan bentuknya. Dua fungsi di bawah sengaja dipisah dari
// saveMachineInfo: yang ini membaca/menulis kolom secara MENTAH, sedangkan
// penyusunan isi JSON-nya dikerjakan lib/session.ts (fungsi murni, mudah diuji).

/** Kolom `machine_info` seorang user, mentah. */
export async function readMachineInfo(sql: Sql, userId: string): Promise<string | null> {
	const rows = await sql<{ machine_info: string | null }[]>`
		select machine_info from ${sql(TABLE_USER)}
		where user_id = ${userId}::int8
		limit 1
	`;
	return rows[0]?.machine_info ?? null;
}

/**
 * Timpa `machine_info` dengan isi yang sudah disusun pemanggil, TAPI hanya
 * kalau isinya masih sama dengan yang dibaca tadi (`compare-and-set`).
 *
 * Kenapa perlu: alur login menulis catatan sesi, sedangkan FE mengirim
 * `machine_info` di permintaan terpisah yang bisa datang hampir bersamaan.
 * Kalau keduanya menulis tanpa memeriksa, yang belakangan menimpa yang duluan
 * dan catatan sesi bisa hilang. Dengan pemeriksaan ini, permintaan yang
 * kalah balapan cukup diulang sekali lagi oleh pemanggil.
 *
 * Mengembalikan false = isi kolom sudah berubah; pemanggil wajib baca ulang.
 */
export async function saveMachineInfoIf(
	sql: Sql,
	userId: string,
	expected: string | null,
	next: string,
): Promise<boolean> {
	// `is not distinct from` membandingkan dengan benar walau nilainya NULL.
	const rows =
		expected === null
			? await sql`
					update ${sql(TABLE_USER)} set machine_info = ${next}, updated_at = now()
					where user_id = ${userId}::int8 and machine_info is null
					returning user_id
				`
			: await sql`
					update ${sql(TABLE_USER)} set machine_info = ${next}, updated_at = now()
					where user_id = ${userId}::int8 and machine_info = ${expected}
					returning user_id
				`;
	return rows.length > 0;
}
