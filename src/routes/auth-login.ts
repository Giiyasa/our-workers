/**
 * POST /api/auth/login
 *
 * Masuk pakai `email` + `password`. Tiga kemungkinan hasil, dan ketiganya
 * dibedakan dengan kode status supaya frontend tidak bisa salah tafsir:
 *
 *   200  kredensial benar DAN `is_verified = true`
 *        -> sesi dibuat, token akses dikirim balik
 *
 *   403  kredensial benar TAPI `is_verified = false`
 *        -> BUKAN login sukses. Kode OTP dikirim ke email user, dan frontend
 *           harus menampilkan form OTP. Kode alasannya `BELUM_VERIFIKASI`.
 *
 *   401  email tidak terdaftar, password salah, atau `password_hash` kosong
 *        -> satu jawaban yang sama untuk ketiga sebab itu, supaya tidak
 *           memberi tahu penebak email mana yang terdaftar.
 *
 * Catatan soal batas: kolom `user.access_role_code/name` TIDAK ditegakkan di
 * sini — peran dibaca dan dikirim sebagai informasi, penegakannya urusan rute
 * masing-masing.
 */

import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } from "../config";
import { burnPasswordTime, isValidEmail, normalizeEmail, verifyPassword } from "../lib/auth";
import { startSession, sessionSummary, ttlDariRequest } from "../lib/auth-session";
import { issueAndSendOtp, otpDigitsFromHeader, otpResponseBody } from "../lib/auth-otp";
import { decideDevice, deviceIdFrom, deviceIdProblem, deviceNameFrom, rememberDevice } from "../lib/auth-device";
import { findLiveOtp, findUserByEmail, shapeUser, readDbNow } from "../lib/auth-store";
import type { Sql } from "../lib/db";
import { readJsonBody, stringField } from "../lib/body";
import { fail, json } from "../lib/http";
import type { DbRoute } from "../lib/types";

interface Input {
	email: string;
	password: string;
	/** Umur token yang diminta FE (detik), sudah dijaga dalam batas. */
	ttlS: number;
	digits: number;
	/** `MachineGuid` komputer yang meminta. Kosong = FE belum mengirim (400). */
	deviceId: string;
	/** Nama komputer, boleh kosong. */
	deviceName: string;
}

export const authLoginRoute: DbRoute<Input> = {
	method: "POST",
	path: "/api/auth/login",
	token: "none",
	requiresDb: true,
	prepare: async ({ request, url }) => {
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const email = normalizeEmail(stringField(parsed.value, "email"));
		const password = stringField(parsed.value, "password");

		if (!email || !password) {
			return fail(400, "Field `email` dan `password` wajib diisi.");
		}
		if (!isValidEmail(email)) {
			return fail(400, "Bentuk email tidak sah.");
		}
		// Batas panjang diperiksa SEBELUM menghitung hash: menghitung
		// SHA-256 atas password sepanjang apa pun membuang CPU Worker, dan
		// itu gratis untuk penyerang yang membanjiri endpoint login.
		if (email.length > MAX_EMAIL_LENGTH) {
			return fail(400, `Email terlalu panjang (maksimum ${MAX_EMAIL_LENGTH} karakter).`);
		}
		if (password.length > MAX_PASSWORD_LENGTH) {
			return fail(400, `Password terlalu panjang (maksimum ${MAX_PASSWORD_LENGTH} karakter).`);
		}

		// Perangkat diperiksa SEBELUM hashing password: permintaan yang tidak
		// membawa identitas komputer tidak bisa dilanjutkan sama sekali, jadi
		// jangan buang CPU menghitung SHA-256 untuknya.
		const deviceId = deviceIdFrom(request, parsed.value);
		const masalahPerangkat = deviceIdProblem(deviceId);
		if (masalahPerangkat) return fail(400, masalahPerangkat, "PERANGKAT_TIDAK_JELAS");

		// Umur token boleh diminta FE lewat header/query; kosong atau bukan
		// angka berarti "tidak diminta" -> bawaan 7 hari. (Catatan: versi lama
		// memakai `Number(header ?? "")` — `Number("")` = 0, jadi permintaan
		// tanpa header pernah terbaca "minta 0 detik" dan dijepit jadi 60 detik.)
		return {
			input: {
				email,
				password,
				ttlS: ttlDariRequest(request, url),
				digits: otpDigitsFromHeader(request),
				deviceId,
				deviceName: deviceNameFrom(request, parsed.value),
			},
		};
	},

	handle: async ({ env }, { email, password, ttlS, digits, deviceId, deviceName }, sql) => {
		const user = await findUserByEmail(sql, email);

		// ---------------------------------------------------------------
		// Email tidak terdaftar. Tetap hitung hash password seolah-olah user
		// ada, supaya waktu responsnya sama dengan email yang terdaftar —
		// selisih waktu bisa dipakai menebak email mana yang punya akun.
		// ---------------------------------------------------------------
		if (!user) {
			await burnPasswordTime(password);
			return fail(401, "Email atau password salah.");
		}

		const cocok = await verifyPassword(password, user.password_hash);
		if (!cocok) {
			return fail(401, "Email atau password salah.");
		}

		// ---------------------------------------------------------------
		// Kredensial benar, tapi akunnya belum diverifikasi: kirim kode OTP,
		// jangan buat sesi. 403 (bukan 200) supaya FE tidak menganggapnya
		// sudah login.
		// ---------------------------------------------------------------
		if (!user.is_verified) {
			const hasil = await kirimAtauPakaiKode(sql, env, email, String(user.user_id), digits);
			if (!hasil.body) {
				// Batas laju: kode lama masih terlalu baru untuk diganti.
				return json(
					{
						ok: false,
						code: "TUNGGU_SEBENTAR",
						error: hasil.blocked?.pesan ?? "Kode sebelumnya masih berlaku.",
						butuh_verifikasi: true,
						email,
						tunggu_detik: hasil.blocked?.tungguDetik ?? 0,
					},
					429,
				);
			}
			return json(
				{
					ok: false,
					code: "BELUM_VERIFIKASI",
					error: "Akun belum diverifikasi. Masukkan kode OTP yang dikirim ke email.",
					butuh_verifikasi: true,
					email,
					user_id: String(user.user_id),
					otp: hasil.body,
				},
				403,
			);
		}

		// ---------------------------------------------------------------
		// Kredensial benar. Sekarang pertanyaan kedua: KOMPUTER mana yang
		// boleh memakai akun ini.
		//
		// Diperiksa SEBELUM sesi dibuat, dan urutannya disengaja: kalau
		// sesinya dibuat lebih dulu lalu perangkatnya ditolak, komputer lama
		// akan ikut tertendang hanya karena ada orang menebak password dari
		// komputer lain.
		// ---------------------------------------------------------------
		const nowS = Math.floor((await readDbNow(sql)).getTime() / 1000);
		const userId = String(user.user_id);
		const device = await decideDevice(sql, userId, { device_id: deviceId, device_name: deviceName }, nowS);

		if (!device.ok) {
			// Sesi lama SENGAJA dibiarkan hidup: pemiliknya di komputer yang
			// benar tidak boleh kehilangan sesinya karena percobaan dari
			// komputer lain. Nama komputer terdaftar juga tidak ikut dikirim
			// — itu akan membocorkan keterangan pemilik akun ke penebak.
			return json(
				{
					ok: false,
					code: "PERANGKAT_LAIN",
					error: "Akun ini sudah terdaftar di komputer lain.",
					petunjuk: "Beli Akses Baru dong, atau di rodok mas rusdi loh ya.",
				},
				403,
			);
		}

		// Perangkat ini sebelumnya belum terdaftar (atau waktunya perlu
		// disegarkan). Ditulis sebelum sesi terbit.
		if (device.perluDaftar && device.catatanBaru) {
			const tersimpan = await rememberDevice(sql, userId, device.catatanBaru);
			if (!tersimpan) {
				return fail(409, "Data perangkat gagal disimpan karena ada perubahan bersamaan. Coba lagi.");
			}
		}

		// ---------------------------------------------------------------
		// Login sukses: catat sesi (masa berlaku ikut tersimpan) lalu terbitkan
		// token. `machine_info` yang dikirim FE ditangani rute terpisah
		// (POST /api/auth/machine), tidak di sini.
		// ---------------------------------------------------------------
		const started = await startSession(sql, env, userId, user.password_hash, ttlS);

		return json({
			ok: true,
			status: "login",
			user: shapeUser(user),
			session: sessionSummary(started, nowS),
			perangkat: device.perangkat
				? { device_name: device.perangkat.device_name, sumber: device.sumber }
				: { device_name: deviceName, sumber: "baru" },
			machine_info_diminta: true,
			petunjuk: "Simpan `session.token_hash` di aplikasi, lalu kirim `machine_info` ke POST /api/auth/machine.",
		});
	},
};

/**
 * Pakai kode OTP yang masih hidup, atau terbitkan yang baru.
 *
 * Kalau sudah ada kode hidup yang belum kadaluarsa, kode itu TIDAK diganti dan
 * emailnya TIDAK dikirim ulang — supaya percobaan login berulang tidak
 * menghabiskan kuota kirim (5 per jam) hanya karena emailnya telat dibuka.
 */
async function kirimAtauPakaiKode(
	sql: Sql,
	env: Env,
	email: string,
	userId: string,
	digits: number,
): Promise<{ body: Record<string, unknown> | null; blocked?: { pesan: string; tungguDetik: number } }> {
	const live = await findLiveOtp(sql, userId);
	if (live && live.sisaDetik !== null && live.sisaDetik > 0) {
		return {
			body: {
				otp_dikirim: false,
				masih_berlaku: true,
				berlaku_detik: Math.floor(live.sisaDetik),
				digits: String(live.otp_code).length,
				pesan: "Kode sebelumnya masih berlaku. Cek email, atau kirim ulang setelah jedanya lewat.",
			},
		};
	}

	const hasil = await issueAndSendOtp(sql, env, email, userId, digits);
	if (!hasil.ok) {
		return { body: null, blocked: { pesan: hasil.pesan, tungguDetik: hasil.tunggu_detik } };
	}
	return { body: otpResponseBody(hasil) };
}
