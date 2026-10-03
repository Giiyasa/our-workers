/**
 * POST /api/auth/resend-otp
 *
 * Kirim ulang kode verifikasi ke email.
 *
 * Dipakai juga untuk akun yang SUDAH terverifikasi tapi belum bisa masuk
 * (mis. login gagal karena `is_verified` dimatikan admin, atau user baru saja
 * ganti email). Kode lama otomatis ditutup saat kode baru terbit — satu kode
 * hidup per user.
 *
 * Batas lajunya ada di lapisan database, jadi menjawab "email tidak terdaftar"
 * pun tidak bisa dipakai menebak-nebak: kalau emailnya tidak ada, responsnya
 * tetap sama bentuknya (200) tanpa ada kode yang benar-benar terbit. Hanya
 * waktu respons yang bisa berbeda — itu pun sudah dirapikan dengan
 * `burnPasswordTime`-nya `verifyPassword`.
 */

import { isValidEmail, normalizeEmail } from "../lib/auth";
import { issueAndSendOtp, otpDigitsFromHeader, otpResponseBody } from "../lib/auth-otp";
import { findUserByEmail } from "../lib/auth-store";
import { readJsonBody, stringField } from "../lib/body";
import { fail, json } from "../lib/http";
import type { DbRoute } from "../lib/types";

interface Input {
	email: string;
	digits: number;
}

export const authResendOtpRoute: DbRoute<Input> = {
	method: "POST",
	path: "/api/auth/resend-otp",
	token: "none",
	requiresDb: true,
	prepare: async ({ request }) => {
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const email = normalizeEmail(stringField(parsed.value, "email"));
		if (!email) return fail(400, "Field `email` wajib diisi.");
		if (!isValidEmail(email)) return fail(400, "Bentuk email tidak sah.");
		return { input: { email, digits: otpDigitsFromHeader(request) } };
	},

	handle: async ({ env }, { email, digits }, sql) => {
		const user = await findUserByEmail(sql, email);

		// Akun sudah terverifikasi: kirim kode tetap boleh (dipakai kalau user
		// perlu masuk lagi tapi kode verifikasinya belum sampai sebelumnya).
		if (!user) {
			// Email tidak terdaftar: jangan bocorkan. Bentuk respons disamakan
			// supaya tidak ada bedanya di mata penebak email.
			//
			// `terkirim: false` menggantikan pasangan `otp_dikirim: true` +
			// `berlaku_detik: 0` yang lama. Pasangan itu saling bertentangan:
			// "kode terkirim, tapi masa berlakunya nol". Aplikasi yang membacanya
			// bisa menampilkan hitung mundur nol lalu mengaktifkan tombol kirim
			// ulang, padahal kiriman berikutnya pun tidak akan sampai.
			return json({
				ok: true,
				terkirim: false,
				mode_email: "tidak-diketahui",
				digits,
			});
		}

		const hasil = await issueAndSendOtp(sql, env, email, String(user.user_id), digits);
		if (!hasil.ok) {
			return json(
				{
					ok: false,
					code: "TUNGGU_SEBENTAR",
					error: hasil.pesan,
					tunggu_detik: hasil.tunggu_detik,
				},
				429,
			);
		}

		return json({ ok: true, ...otpResponseBody(hasil) });
	},
};
