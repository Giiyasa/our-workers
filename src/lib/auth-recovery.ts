/**
 * Pekerjaan database untuk kode pemulihan perangkat (tabel `recovery_user`).
 *
 * Rute menyusun urutan dan bentuk respons; seluruh SQL-nya ada di sini, sama
 * seperti janji di lib/auth-store.ts.
 *
 * ============================================================================
 * SKEMA YANG DIPAKAI (disediakan pihak lain, TIDAK dibuat worker ini)
 * ============================================================================
 *   id           int8  primary identity   -> driver mengembalikan STRING
 *   user_id      int8                     -> STRING
 *   recovery_key int4  UNIQUE             -> number
 *   is_used      bool
 *   machine_info text  NULLABLE
 *   created_at / updated_at timestamptz
 *
 * Catatan `recovery_key int4`: angka, jadi digit pertama tidak pernah nol
 * ("0123456" dan "123456" adalah baris yang sama). Kode dibandingkan sebagai
 * teks lalu di-cast `::int4` supaya nol di depan tidak menghasilkan kode yang
 * berbeda dari yang tersimpan.
 *
 * ============================================================================
 * BATAS PERCOBAAN — kenapa barisnya di tabel `otp`, bukan `recovery_user`
 * ============================================================================
 * Percobaan kode pemulihan yang gagal harus dihitung, tapi tidak ada kolom
 * penghitung di `recovery_user`. Pola yang sudah dipakai untuk OTP adalah
 * menyisipkan baris PENANDA lalu menghitungnya — tapi di sini penanda tidak
 * bisa ditaruh di `recovery_user`: `recovery_key`-nya UNIQUE, jadi penanda
 * dengan nilai tetap (mis. 0) hanya akan pernah ada SATU baris untuk seluruh
 * tabel, dan hitungannya selalu 1.
 *
 * Maka penandanya ditaruh di tabel `otp` — tabel yang sama yang sudah dipakai
 * menghitung percobaan OTP gagal. `user_id`-nya diisi user yang sedang
 * mencoba, nilai kodenya RECOVERY_FAILURE_MARK (= 1, di bawah 1000 sehingga
 * tidak mungkin tertukar dengan kode OTP sungguhan).
 *
 * Kebijakannya SENGAJA bukan "3 kali salah lalu kode dimatikan": worker TIDAK
 * boleh menandai baris `recovery_user` jadi terpakai karena tebakan yang gagal
 * — itu sama saja membakar kode milik pemiliknya yang cuma salah ketik. Yang
 * dibatasi adalah KECEPATAN mencoba: RECOVERY_MAX_ATTEMPTS percobaan gagal per
 * jendela RECOVERY_ATTEMPT_WINDOW_S, dihitung dari baris penanda di sini.
 */

import { RECOVERY_FAILURE_MARK, TABLE_RECOVERY, TABLE_OTP } from "../config";
import type { Sql } from "./db";
import { readSeconds } from "./auth-time";
import { parseRecoveryDevice, type DeviceRecord } from "./session";

/** Satu baris `recovery_user` yang belum terpakai. */
export interface RecoveryRow {
	/** `id` int8 — STRING dari driver, jangan di-Number(). */
	id: string;
	user_id: string;
	/** int4 — number. */
	recovery_key: number;
	is_used: boolean;
	/**
	 * Catatan perangkat hasil pemakaian kode ini.
	 * NULL = kode belum pernah dipakai untuk memindahkan akun.
	 */
	machine_info: string | null;
}

/**
 * Cari baris pemulihan yang cocok dengan email + kode.
 *
 * Mengembalikan juga baris yang SUDAH terpakai, supaya rute bisa membedakan
 * "kode salah" dari "kode sudah dipakai" — pembedaan itu disengaja: pengguna
 * yang memegang kode benar tapi sudah terpakai tidak perlu menghabiskan sisa
 * percobaannya, cukup diberi tahu minta kode baru ke admin.
 */
export async function findRecoveryRow(
	sql: Sql,
	userId: string,
	recoveryKey: string,
): Promise<RecoveryRow | null> {
	const rows = await sql<RecoveryRow[]>`
		select id, user_id, recovery_key, is_used, machine_info
		from ${sql(TABLE_RECOVERY)}
		where user_id = ${userId}::int8 and recovery_key = ${recoveryKey}::int4
		limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		recovery_key: Number(row.recovery_key),
		is_used: Boolean(row.is_used),
		machine_info: row.machine_info ?? null,
	};
}

/**
 * Catatan perangkat pemulihan yang BERLAKU untuk sebuah akun.
 *
 * Satu akun bisa punya beberapa baris `recovery_user` (stok kode dari admin).
 * Yang berlaku adalah baris yang sudah terpakai dan berisi keterangan
 * perangkat; kalau ada lebih dari satu, yang paling baru diperbarui yang
 * menang — itulah baris dari perpindahan terakhir.
 */
export async function readRecoveryDevice(sql: Sql, userId: string): Promise<DeviceRecord | null> {
	const rows = await sql<{ machine_info: string | null }[]>`
		select machine_info from ${sql(TABLE_RECOVERY)}
		where user_id = ${userId}::int8 and machine_info is not null
		order by updated_at desc
		limit 1
	`;
	return parseRecoveryDevice(rows[0]?.machine_info ?? null);
}

/**
 * Pakai baris pemulihan: tulis catatan perangkat DAN tandai terpakai.
 *
 * Keduanya dalam SATU transaksi — kalau salah satu gagal, keduanya batal.
 * Kalau tidak, ada celah: catatan perangkat sudah menunjuk komputer baru tapi
 * kodenya masih dianggap hidup, sehingga kode yang sama bisa dipakai lagi
 * (dan menunjuk komputer lain) di kemudian hari.
 *
 * DUA bentuk penulisan, dipilih pemanggil lewat `isiCatatan`:
 *   - baris masih NULL  -> tulis catatan perangkat
 *   - baris sudah berisi-> isinya HARUS sama (tidak ditimpa); hanya `is_used`
 *                          yang berubah
 *
 * `expectMachineInfo` adalah syarat baris yang di-update (`where machine_info
 * is null` atau `= nilai lama`). Kalau nol baris ter-update, artinya ada
 * perubahan bersamaan dan pemanggil harus membaca ulang.
 */
export async function claimRecoveryRow(
	sql: Sql,
	rowId: string,
	expectMachineInfo: string | null,
	catatan: string,
): Promise<boolean> {
	let claimed = false;

	await sql.begin(async (tx) => {
		const rows =
			expectMachineInfo === null
				? await tx`
						update ${tx(TABLE_RECOVERY)}
						set machine_info = ${catatan}, is_used = true, updated_at = now()
						where id = ${rowId}::int8 and is_used = false and machine_info is null
						returning id
					`
				: await tx`
						update ${tx(TABLE_RECOVERY)}
						set is_used = true, updated_at = now()
						where id = ${rowId}::int8
							and is_used = false
							and machine_info = ${expectMachineInfo}
						returning id
					`;
		claimed = rows.length > 0;
		if (!claimed) {
			// Batal tanpa error: pemanggil akan membaca ulang dan memutuskan.
			throw new ClaimCancelled();
		}
	});

	return claimed;
}

/** Ditembak di dalam transaksi untuk membatalkannya tanpa pesan error asing. */
class ClaimCancelled extends Error {
	constructor() {
		super("baris pemulihan berubah bersamaan");
		this.name = "ClaimCancelled";
	}
}

/** Apakah error berasal dari pembatalan claim (bukan kegagalan database). */
export function isClaimCancelled(err: unknown): boolean {
	return err instanceof ClaimCancelled;
}

// ---------------------------------------------------------------------------
// Batas percobaan kode pemulihan
// ---------------------------------------------------------------------------

/** Catat satu percobaan kode pemulihan yang gagal. */
export async function recordFailedRecoveryAttempt(sql: Sql, userId: string): Promise<void> {
	await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${RECOVERY_FAILURE_MARK}, true, now(), now(), now())
	`;
}

/**
 * Jumlah percobaan kode pemulihan yang gagal dalam `windowS` detik terakhir.
 *
 * Dihitung dari baris penanda RECOVERY_FAILURE_MARK di tabel `otp`, dibatasi
 * jendela waktu supaya pengguna yang salah ketik pagi ini tidak terkunci
 * seharian.
 */
export async function countFailedRecoveryAttempts(
	sql: Sql,
	userId: string,
	windowS: number,
): Promise<number> {
	const rows = await sql<{ jumlah: number }[]>`
		select count(*)::int as jumlah
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${RECOVERY_FAILURE_MARK}
			and created_at > now() - ${windowS} * interval '1 second'
	`;
	return Number(rows[0]?.jumlah ?? 0);
}

/**
 * Detik sampai percobaan berikutnya boleh dicoba lagi.
 *
 * Dipakai untuk mengisi `tunggu_detik` pada jawaban 429: jendela dihitung
 * dari percobaan gagal yang paling lama di dalam jendela, karena itu yang
 * pertama kali akan keluar dari hitungan.
 */
export async function recoveryRetryAfterS(
	sql: Sql,
	userId: string,
	windowS: number,
): Promise<number> {
	const rows = await sql<{ jeda_detik: unknown }[]>`
		select extract(epoch from (now() - min(created_at))) as jeda_detik
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${RECOVERY_FAILURE_MARK}
			and created_at > now() - ${windowS} * interval '1 second'
	`;
	const jeda = readSeconds(rows[0]?.jeda_detik);
	if (jeda === null) return 0;
	return Math.max(0, Math.ceil(windowS - jeda));
}

/** Susun keterangan perangkat untuk disimpan di `recovery_user.machine_info`. */
export function recoveryMachineInfo(device: DeviceRecord): string {
	return JSON.stringify(device);
}
