/**
 * Penjaga sesi untuk rute yang butuh login.
 *
 * Dipakai DUA jalur sekaligus, dan hasil pemeriksaannya sama:
 *
 *   A. jalur token penuh
 *      Client mengirim token utuh di header `X-Access-Token`. Token diperiksa
 *      tanda tangannya, masa berlakunya, dan sidik jari kredensialnya, lalu
 *      dicocokkan dengan catatan sesi di `user.machine_info` (lib/session.ts).
 *
 *   B. jalur sidik jari (aplikasi desktop)
 *      Aplikasi desktop menyimpan hanya `md5(token)` dan mengirimkannya di
 *      header `X-Access-Token` bersama `X-User-Id`. Token aslinya memang tidak
 *      ikut tersimpan di komputer user, jadi tanda tangannya tidak bisa
 *      diperiksa di sini. Yang diperiksa: catatan sesi ada, `sesi.th` sama
 *      dengan sidik jari yang dikirim, `sesi.fp` sama dengan sidik jari
 *      kredensial sekarang, dan masa berlaku belum habis (waktu DATABASE).
 *
 * Kenapa B tidak lebih lemah dalam hal yang penting: sidik jarinya hanya
 * diketahui pemilik sesi (dihasilkan Worker saat login), masa berlakunya
 * dipegang database, dan mencabutnya (logout / ganti password) langsung
 * berlaku — tanpa tabel sesi.
 *
 * `code` di hasil penolakan dipakai frontend untuk membedakan sebabnya dan
 * langsung menendang user ke halaman login.
 */

import { DEVICE_ID_HEADER, TABLE_USER } from "../config";
import { credentialFingerprint, readAccessToken, resolveAuthSecret, tokenHash } from "./auth";
import { readDbNow } from "./auth-store";
import { readRecoveryDevice } from "./auth-recovery";
import { deviceIdProblem } from "./auth-device";
import type { Sql } from "./db";
import {
	perangkatSah,
	readMachineParts,
	sessionAcceptsFingerprint,
	sessionExpired,
	sessionMatches,
	type DeviceRecord,
	type SessionRecord,
} from "./session";

/** Ringkasan sesi yang lolos pemeriksaan. */
export interface LiveSession {
	/** Cara sesi dibuktikan: token utuh, atau sidik jarinya. */
	mode: "token" | "sidik-jari";
	userId: string;
	sesi: SessionRecord;
	/** Sisa masa berlaku menurut jam DATABASE (detik). */
	sisaDetik: number;
	/** Perangkat yang sah untuk akun ini (aturan dua tingkat, lihat perangkatSah). */
	perangkat: DeviceRecord | null;
	/** Dari catatan mana perangkat itu dibaca. Null kalau belum ada perangkat. */
	sumberPerangkat: "pemulihan" | "login" | "kosong";
}

export type SessionFailCode =
	| "TOKEN_TIDAK_ADA"
	| "TOKEN_TIDAK_SAH"
	| "SESI_HABIS"
	| "SESI_TIDAK_DIKENAL"
	| "AKUN_TIDAK_ADA"
	| "USER_ID_TIDAK_ADA"
	| "PERANGKAT_TIDAK_JELAS"
	| "PERANGKAT_TIDAK_COCOK";

export type SessionCheck = { ok: true; session: LiveSession } | { ok: false; code: SessionFailCode; error: string };

const FAIL_TEXT: Record<SessionFailCode, string> = {
	TOKEN_TIDAK_ADA: "Header X-Access-Token wajib diisi.",
	TOKEN_TIDAK_SAH: "Sesi tidak sah. Silakan login ulang.",
	SESI_HABIS: "Masa berlaku sesi sudah habis. Silakan login ulang.",
	SESI_TIDAK_DIKENAL: "Sesi sudah tidak berlaku (sudah logout atau diganti perangkat lain). Silakan login ulang.",
	AKUN_TIDAK_ADA: "Akun tidak ditemukan. Silakan login ulang.",
	USER_ID_TIDAK_ADA: "Header X-User-Id tidak ada atau bukan angka.",
	PERANGKAT_TIDAK_JELAS: `Header X-Device-Id wajib diisi dan berisi identitas komputer.`,
	PERANGKAT_TIDAK_COCOK:
		"Sesi ini milik komputer lain. Masuk dari komputer yang terdaftar, atau pindah lewat kode pemulihan.",
};

function fail(code: SessionFailCode): SessionCheck {
	return { ok: false, code, error: FAIL_TEXT[code] };
}

/**
 * Status HTTP untuk sebuah kode kegagalan sesi.
 *
 * Dua kode sengaja 400, bukan 401: `PERANGKAT_TIDAK_JELAS` dan
 * `USER_ID_TIDAK_ADA` bukan "sesi sudah tidak berlaku", melainkan permintaan
 * yang bentuknya salah — ciri bug aplikasi. Kalau keduanya dijawab 401,
 * aplikasi desktop akan menghapus sesi pengguna dan menendangnya ke layar
 * masuk hanya karena dirinya sendiri lupa mengirim satu header.
 *
 * Sisanya 401, dan itu memang tujuannya: satu kode status yang membuat
 * aplikasi membersihkan sesi dan meminta login ulang, dengan `code` di body
 * menjelaskan sebabnya.
 */
export function sessionFailStatus(code: SessionFailCode): number {
	return code === "PERANGKAT_TIDAK_JELAS" || code === "USER_ID_TIDAK_ADA" ? 400 : 401;
}

/** Bentuk sidik jari yang sah: MD5 heksadesimal 32 huruf. */
export function looksLikeTokenHash(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value);
}

/** Hasil pemeriksaan pendahuluan header sesi (tanpa database). */
export type SessionPreflight =
	| { ok: true; mode: "token" | "sidik-jari"; userId: string }
	| { ok: false; status: number; error: string; code: SessionFailCode };

/**
 * Periksa header sesi TANPA membuka database — dipakai rute di `prepare()`.
 *
 * Kenapa ini dipisah dari `requireSession()`: seluruh kontrak project ini
 * menaruh penolakan di SEBELUM koneksi database dibuka (lihat lib/types.ts).
 * Tanpa pemeriksaan ini, permintaan dengan token ngawur tetap membuka koneksi
 * ke Postgres sebelum ditolak — artinya membanjiri endpoint dengan token
 * sampah cukup untuk menghabiskan koneksi database, padahal tidak satu pun
 * permintaan itu mungkin berhasil.
 *
 * Yang bisa diperiksa di sini hanya bentuk + tanda tangan token (tidak butuh
 * query). Pencocokan dengan catatan sesi di `user.machine_info` tetap
 * dikerjakan `requireSession()` di dalam `handle()`.
 */
export function preflightSession(request: Request, env: Env): SessionPreflight {
	const raw = request.headers.get("x-access-token");
	if (!raw) return { ok: false, status: 401, error: FAIL_TEXT.TOKEN_TIDAK_ADA, code: "TOKEN_TIDAK_ADA" };

	if (raw.startsWith("v1.")) {
		const { secret } = resolveAuthSecret(env);
		const result = readAccessToken(raw, secret);
		if (!result.ok) {
			const code: SessionFailCode = result.reason === "expired" ? "SESI_HABIS" : "TOKEN_TIDAK_SAH";
			return { ok: false, status: 401, error: FAIL_TEXT[code], code };
		}
		return { ok: true, mode: "token", userId: result.info.userId };
	}

	if (!looksLikeTokenHash(raw)) {
		return { ok: false, status: 401, error: FAIL_TEXT.TOKEN_TIDAK_SAH, code: "TOKEN_TIDAK_SAH" };
	}

	// Jalur sidik jari: md5(token) tidak menyimpan identitas, jadi user_id
	// WAJIB ikut dikirim. Tanpa ini permintaan tidak bisa dilanjutkan sama
	// sekali — jadi 400, bukan 401.
	const userId = (request.headers.get("x-user-id") ?? "").trim();
	if (!/^[0-9]{1,20}$/.test(userId)) {
		return { ok: false, status: 400, error: FAIL_TEXT.USER_ID_TIDAK_ADA, code: "USER_ID_TIDAK_ADA" };
	}
	return { ok: true, mode: "sidik-jari", userId };
}

/** Baris `user` yang dibutuhkan pemeriksaan sesi. */
interface SessionUserRow {
	user_id: string;
	password_hash: string | null;
	machine_info: string | null;
}

/**
 * Periksa sesi.
 *
 * Urutannya sengaja: tentukan dulu siapa user-nya (dari token utuh, atau dari
 * header `X-User-Id` untuk jalur sidik jari), baru baca baris user, lalu
 * berakhir di pemeriksaan catatan sesi yang satu itu — supaya kedua jalur
 * tidak bisa berbeda aturan.
 */
export async function requireSession(
	sql: Sql,
	env: Env,
	request: Request,
	userIdHeader: string | null,
): Promise<SessionCheck> {
	const raw = request.headers.get("x-access-token");
	if (!raw) return fail("TOKEN_TIDAK_ADA");

	const nowS = Math.floor((await readDbNow(sql)).getTime() / 1000);
	const { secret } = resolveAuthSecret(env);

	// ------------------------------------------------------------------------
	// Tentukan siapa user-nya. Token utuh menentukan sendiri; sidik jari butuh
	// header `X-User-Id` karena md5(token) tidak menyimpan identitas apa pun.
	// ------------------------------------------------------------------------
	const isFullToken = raw.startsWith("v1.");
	let userId = (userIdHeader ?? "").trim();

	if (isFullToken) {
		const result = readAccessToken(raw, secret);
		if (!result.ok) {
			// "expired" dibedakan supaya frontend bisa menampilkan pesan yang pas.
			return fail(result.reason === "expired" ? "SESI_HABIS" : "TOKEN_TIDAK_SAH");
		}
		// Kalau client salah mengisi X-User-Id, token tetap yang menentukan.
		userId = result.info.userId;
	} else if (!looksLikeTokenHash(raw)) {
		// Bukan token utuh dan bukan sidik jari -> tolak sebelum menyentuh DB.
		return fail("TOKEN_TIDAK_SAH");
	}

	if (!userId) return fail("USER_ID_TIDAK_ADA");
	if (!/^[0-9]{1,20}$/.test(userId)) return fail("USER_ID_TIDAK_ADA");

	// ------------------------------------------------------------------------
	// Pemeriksaan bersama: catatan sesi harus ada dan belum lewat masa berlaku.
	// ------------------------------------------------------------------------
	const rows = await sql<SessionUserRow[]>`
		select user_id, password_hash, machine_info
		from ${sql(TABLE_USER)} where user_id = ${userId}::int8 limit 1
	`;
	const row = rows[0];
	if (!row) return fail("AKUN_TIDAK_ADA");

	const parts = readMachineParts(row.machine_info);
	if (!parts.sesi) return fail("SESI_TIDAK_DIKENAL");
	if (sessionExpired(parts.sesi, nowS)) return fail("SESI_HABIS");

	// ------------------------------------------------------------------------
	// Sesi memang sah — tapi milik KOMPUTER mana?
	//
	// Inilah yang membuat menyalin berkas sesi ke komputer lain tidak
	// berguna: `token_hash` boleh saja benar, tapi `X-Device-Id` komputer
	// yang mengirimnya dibandingkan dengan perangkat yang SAH untuk akun ini.
	//
	// Yang dibandingkan adalah hasil perangkatSah(), BUKAN
	// `parts.perangkat` langsung. Bedanya penting: begitu akun dipindahkan
	// lewat kode pemulihan, catatan pemulihan yang berlaku, dan catatan
	// login masih menyebut komputer lama. Membandingkan langsung ke catatan
	// login akan menendang pengguna yang baru saja berhasil memulihkan.
	// ------------------------------------------------------------------------
	const deviceId = (request.headers.get(DEVICE_ID_HEADER) ?? "").trim();
	if (deviceIdProblem(deviceId)) return fail("PERANGKAT_TIDAK_JELAS");

	const pemulihan = await readRecoveryDevice(sql, userId);
	const sah = perangkatSah(parts.perangkat, pemulihan);
	if (!sah.perangkat || sah.perangkat.device_id !== deviceId) {
		return fail("PERANGKAT_TIDAK_COCOK");
	}

	if (isFullToken) {
		// Token sudah lolos tanda tangan di atas; sekarang pastikan ia memang
		// sesi yang tercatat (exp sama, kredensial tidak berubah sejak diterbitkan).
		const checked = readAccessToken(raw, secret, { passwordHash: row.password_hash });
		if (!checked.ok) return fail("TOKEN_TIDAK_SAH");
		if (!sessionMatches(parts.sesi, checked.info)) return fail("SESI_TIDAK_DIKENAL");
	} else {
		const credentialFp = credentialFingerprint(row.password_hash);
		if (!sessionAcceptsFingerprint(parts.sesi, raw, credentialFp, nowS)) {
			return fail("SESI_TIDAK_DIKENAL");
		}
	}

	return {
		ok: true,
		session: {
			mode: isFullToken ? "token" : "sidik-jari",
			userId: String(row.user_id),
			sesi: parts.sesi,
			sisaDetik: parts.sesi.exp - nowS,
			perangkat: sah.perangkat,
			sumberPerangkat: sah.sumber,
		},
	};
}

/**
 * Sidik jari token untuk dikirim ke aplikasi desktop.
 *
 * Dipakai rute login supaya nilai yang disimpan aplikasi desktop dihitung di
 * SATU tempat saja — kalau dihitung di dua tempat dengan cara berbeda,
 * pemeriksaannya tidak akan pernah cocok.
 */
export function fingerprintForClient(token: string): string {
	return tokenHash(token);
}
