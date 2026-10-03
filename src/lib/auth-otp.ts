/**
 * Penerbitan kode OTP + pengirimannya lewat email.
 *
 * Dipakai DUA rute (login saat belum terverifikasi, dan kirim ulang kode) supaya
 * aturannya cuma satu tempat: berapa digit, batas laju, dan apa yang dikatakan
 * ke frontend kalau emailnya gagal terkirim.
 *
 * Soal batas laju: yang MENOLAK permintaan bukan rute, tapi lapisan database
 * (`issueOtp` di lib/auth-store.ts) — dihitung dari tabel `otp` sendiri, jadi
 * jeda 60 detik dan kuota 5 kode/jam tidak bisa dilewati dengan mengulang
 * permintaan.
 *
 * Mode uji: kalau belum ada secret email (lihat lib/mail.ts), kode mentahnya
 * ikut dikembalikan sebagai `kode_otp_dev` dan `mode_email: "uji"` supaya
 * frontend bisa mengetes alurnya sekarang juga. Begitu secret dipasang,
 * nilainya hilang sendiri.
 */

import {
	OTP_DIGITS_DEFAULT,
	OTP_DIGITS_HEADER,
	OTP_DIGITS_MAX,
	OTP_DIGITS_MIN,
	OTP_MAX_ATTEMPTS,
	OTP_MIN_INTERVAL_S,
} from "../config";
import { generateStoredOtpCode } from "./auth";
import { issueOtp } from "./auth-store";
import type { Sql } from "./db";
import { mailMode, sendOtpMail } from "./mail";

/** Permintaan kode OTP yang gagal diterbitkan (batas laju). */
export interface OtpBlocked {
	ok: false;
	/** Alasan yang aman dikirim ke frontend. */
	alasan: "baru-saja" | "terlalu-sering";
	pesan: string;
	/** Detik sampai user boleh minta kode lagi. */
	tunggu_detik: number;
}

/** Kode OTP berhasil diterbitkan. */
export interface OtpIssued {
	ok: true;
	digits: number;
	berlaku_detik: number;
	/** Jumlah percobaan salah sebelum kode dimatikan. */
	maks_percobaan: number;
	/** true kalau email benar-benar dikirim (atau mode uji). */
	otp_dikirim: boolean;
	mode_email: string;
	/** Pesan galat pengiriman, null kalau aman. */
	galat_email: string | null;
	/** HANYA terisi di mode uji. */
	kode_otp_dev?: string;
}

export type OtpOutcome = OtpBlocked | OtpIssued;

/** Jumlah digit yang diminta lewat header (dijaga dalam rentang). */
export function otpDigitsFromHeader(request: Request): number {
	const raw = Number(request.headers.get(OTP_DIGITS_HEADER) ?? "");
	if (!Number.isFinite(raw)) return OTP_DIGITS_DEFAULT;
	return Math.min(Math.max(Math.trunc(raw), OTP_DIGITS_MIN), OTP_DIGITS_MAX);
}

/**
 * Terbitkan kode baru untuk user, kirim lewat email, susun hasilnya.
 *
 * Tidak pernah melempar error: kegagalan pengiriman email bukan kegagalan
 * penerbitan kode, dan frontend perlu tahu bedanya (`otp_dikirim: false`).
 */
export async function issueAndSendOtp(
	sql: Sql,
	env: Env,
	email: string,
	userId: string,
	digits: number,
): Promise<OtpOutcome> {
	const code = generateStoredOtpCode(digits);
	const issued = await issueOtp(sql, userId, code);

	if (!issued.ok) {
		return {
			ok: false,
			alasan: issued.reason ?? "baru-saja",
			pesan:
				issued.reason === "terlalu-sering"
					? "Terlalu banyak permintaan kode. Coba lagi nanti."
					: `Kode sebelumnya masih berlaku. Tunggu ${issued.tungguDetik} detik lagi.`,
			tunggu_detik: issued.tungguDetik,
		};
	}

	// Mode uji ditandai terus terang; lihat lib/mail.ts.
	const mode = mailMode(env);
	const sent = await sendOtpMail(env, { to: email, code, berlakuDetik: issued.berlakuDetik });

	const hasil: OtpIssued = {
		ok: true,
		digits,
		berlaku_detik: issued.berlakuDetik,
		maks_percobaan: OTP_MAX_ATTEMPTS,
		otp_dikirim: sent.ok,
		mode_email: sent.mode ?? mode,
		galat_email: sent.error,
	};
	// Kode disertakan HANYA di mode uji, supaya alur FE bisa dites tanpa email.
	if (mode === "uji") hasil.kode_otp_dev = code;
	return hasil;
}

/** Bentuk bagian OTP untuk respons login/verify. */
export function otpResponseBody(hasil: OtpIssued): Record<string, unknown> {
	const body: Record<string, unknown> = {
		otp_dikirim: hasil.otp_dikirim,
		mode_email: hasil.mode_email,
		berlaku_detik: hasil.berlaku_detik,
		digits: hasil.digits,
		// Dikirim supaya aplikasi tidak perlu menyalin konstanta 60 detik ke
		// dalam kodenya sendiri. Kalau nilainya diubah di Worker, hitung
		// mundurnya ikut berubah tanpa ada rilis aplikasi baru.
		kirim_ulang_detik: OTP_MIN_INTERVAL_S,
		maks_percobaan: OTP_MAX_ATTEMPTS,
	};
	if (hasil.galat_email) body.galat_email = hasil.galat_email;
	if (hasil.kode_otp_dev) body.kode_otp_dev = hasil.kode_otp_dev;
	return body;
}
