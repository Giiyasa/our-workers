/**
 * Memulai sesi login: menulis catatan sesi, menerbitkan token, menyiapkan
 * ringkasan untuk dikirim ke client.
 *
 * Dipakai DUA rute (login dan verify) supaya aturannya cuma ada di satu tempat:
 * token yang diterbitkan selalu punya masa berlaku yang sama dengan yang
 * dicatat di `user.machine_info`.
 *
 * ============================================================================
 * CARA KERJA SAMA DENGAN APLIKASI DESKTOP
 * ============================================================================
 * Respons berisi DUA nilai berbeda, dan bedanya penting:
 *
 *   `token`       -> token utuh (v1.<user_id>.<exp>.<tt>.<fp>)
 *   `token_hash`  -> md5(token), 32 huruf
 *
 * Aplikasi desktop sebaiknya menyimpan **`token_hash`** saja. Saat memanggil
 * API, ia mengirim hash itu di header `X-Access-Token` bersama `X-User-Id`.
 * Worker mencocokkannya dengan `sesi.th` di database — jadi:
 *
 *   - token aslinya tidak perlu ikut tersimpan di komputer user;
 *   - sesi tetap bisa dicabut dari server (logout hapus catatan sesi, atau
 *     ganti password mengubah sidik jari kredensial);
 *   - masa berlakunya dipegang database, bukan jam komputer user.
 *
 * Nilai `token` tetap dikirim untuk keperluan uji/manual (mis. `curl`), tapi
 * frontend tidak wajib menyimpannya.
 */

import { ACCESS_TOKEN_MAX_TTL_S, ACCESS_TOKEN_MIN_TTL_S, ACCESS_TOKEN_TTL_S, TOKEN_TTL_HEADER } from "../config";
import { credentialFingerprint, issueAccessToken, resolveAuthSecret, tokenHash } from "./auth";
import { readDbNow, readMachineInfo, saveMachineInfoIf } from "./auth-store";
import type { Sql } from "./db";
import { machineInfoFits, withSession, type SessionRecord } from "./session";

export interface StartedSession {
	/** Token utuh — untuk uji/manual, boleh tidak disimpan client. */
	token: string;
	/** md5(token) — inilah yang disimpan aplikasi desktop. */
	tokenHash: string;
	/** Waktu kadaluarsa (detik UNIX), menurut jam DATABASE. */
	exp: number;
	/** Umur token yang benar-benar dipakai (detik). */
	ttlS: number;
}

/** Jaga umur token yang diminta client tetap dalam batas wajar. */
export function clampTtl(requested: number): number {
	if (!Number.isFinite(requested)) return ACCESS_TOKEN_TTL_S;
	return Math.min(Math.max(Math.trunc(requested), ACCESS_TOKEN_MIN_TTL_S), ACCESS_TOKEN_MAX_TTL_S);
}

/**
 * Baca umur token yang DIMINTA client dari header `x-token-ttl-seconds`
 * atau query `?ttl_s=`.
 *
 * =====================================================================
 * KENAPA BUKAN `Number(header ?? "")` SEKALI BACA
 * =====================================================================
 * Versi lama dari fungsi ini tertanam di tiga rute dan mengandung jebakan
 * JavaScript: `Number("")` hasilnya **0**, dan 0 lolos `Number.isFinite()`.
 * Akibatnya permintaan yang TIDAK menyebut umur token sama sekali (yang
 * normal — aplikasi desktop tidak pernah mengirim header ini) dibaca
 * seolah meminta umur 0 detik, lalu dijepit `clampTtl` ke batas minimum
 * 60 detik. Sesi 7 hari berubah jadi sesi 1 menit, dan aplikasi memaksa
 * login ulang setiap dibuka. Terjadi sungguhan (2026-10-03).
 *
 * Aturannya sekarang tegas: header/query KOSONG atau bukan angka berarti
 * "tidak diminta" -> bawaan 7 hari. Angka apa pun (termasuk 0) berarti
 * permintaan sungguhan -> dijepit `clampTtl` seperti biasa.
 */
export function ttlDariRequest(request: Request, url?: URL): number {
	const teks =
		request.headers.get(TOKEN_TTL_HEADER)?.trim() || url?.searchParams.get("ttl_s")?.trim() || "";
	const parsed = Number(teks);
	// String kosong -> Number("") = 0 -> NaN-nya tidak ada, jadi cek teksnya
	// dulu: kosong berarti tidak diminta, selesai. Selain itu harus angka
	// berhingga; selain itu juga dianggap tidak diminta.
	if (!teks || !Number.isFinite(parsed)) return ACCESS_TOKEN_TTL_S;
	return clampTtl(parsed);
}

/**
 * Mulai sesi untuk seorang user.
 *
 * Batas waktu dihitung dari `now()` DATABASE, lalu ditulis ke catatan sesi DAN
 * ke dalam token. Keduanya harus sama persis; kalau tidak, penjaga sesi akan
 * menolak token yang sebenarnya sah.
 *
 * Penulisan kolom memakai pola bandingkan-lalu-tulis (`saveMachineInfoIf`)
 * dengan satu percobaan ulang, supaya tidak menghapus `machine_info` yang
 * dikirim FE pada saat yang hampir bersamaan.
 *
 * Catatan PERANGKAT tidak ditulis di sini, melainkan oleh pemanggil lewat
 * `rememberDevice()` (auth-device.ts), SEBELUM fungsi ini dipanggil. Urutannya
 * itu yang dipilih: kalau sesi dibuat lebih dulu lalu pendaftaran perangkat
 * gagal, akun sudah bisa dipakai tanpa ada catatan komputer mana yang
 * sah — dan login berikutnya dari komputer lain akan mendaftarkan dirinya
 * sendiri. Sebaliknya, perangkat yang terdaftar tanpa sesi sama sekali tidak
 * berbahaya: orangnya memang sudah tahu password.
 */
export async function startSession(
	sql: Sql,
	env: Env,
	userId: string,
	passwordHash: string | null,
	ttlS: number,
): Promise<StartedSession> {
	const { secret } = resolveAuthSecret(env);
	const nowS = Math.floor((await readDbNow(sql)).getTime() / 1000);

	const sesi: SessionRecord = {
		v: 1,
		exp: nowS + ttlS,
		iat: nowS,
		fp: "",
		th: "",
	};

	// Token diterbitkan lebih dulu karena catatan sesi ikut menyimpan sidik
	// jarinya (`th`) dan sidik jari kredensial (`fp`) yang sama.
	const token = issueAccessToken(userId, passwordHash, secret, ttlS, nowS);
	const hash = tokenHash(token);
	sesi.fp = credentialFingerprint(passwordHash);
	sesi.th = hash;

	let written = false;
	for (let attempt = 0; attempt < 2 && !written; attempt++) {
		const current = await readMachineInfo(sql, userId);
		const next = withSession(current, sesi);
		if (!machineInfoFits(next)) {
			throw new Error("machine_info kepanjangan untuk menyimpan catatan sesi.");
		}
		written = await saveMachineInfoIf(sql, userId, current, next);
	}
	if (!written) throw new Error("Gagal menyimpan catatan sesi (kolom machine_info berubah terus).");

	return { token, tokenHash: hash, exp: sesi.exp, ttlS };
}

/**
 * Ringkasan sesi untuk dikirim ke client.
 *
 * `sisa_detik` dipakai FE untuk menampilkan hitung mundur dan memutuskan kapan
 * harus minta login ulang; kebenaran sesungguhnya tetap dipegang server.
 */
export function sessionSummary(started: StartedSession, nowS: number) {
	return {
		token: started.token,
		token_hash: started.tokenHash,
		token_type: "x-access-token + x-user-id",
		exp: started.exp,
		expired_at: new Date(started.exp * 1000).toISOString(),
		ttl_s: started.ttlS,
		sisa_detik: Math.max(0, started.exp - nowS),
	};
}
