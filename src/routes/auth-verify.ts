/**
 * POST /api/auth/verify
 *
 * Tukar kode OTP jadi sesi login. Dipanggil setelah login membalas
 * `403 BELUM_VERIFIKASI`.
 *
 * Isi body: `email` + `kode` (+ opsional `token_ttl_s`).
 *
 * Alur di dalam:
 *   1. cari kode hidup terbaru milik user (satu kode hidup per user)
 *   2. hitung percobaan salah SETELAH kode itu terbit (baris penanda otp_code = 0)
 *   3. kode salah  -> catat percobaan gagal; sudah lewat batas -> matikan kode
 *   4. kode benar  -> tandai kode terpakai, tandai user terverifikasi,
 *                     buat sesi + token akses
 *
 * Kenapa kode yang sudah kelewat batas DIMATIKAN, bukan cuma ditolak: tanpa itu
 * penebak bisa mencoba terus sampai kode 4 digit itu ketemu, karena tidak ada
 * kolom penghitung di tabel `otp`.
 */

import { OTP_MAX_ATTEMPTS } from '../config';
import { isValidEmail, normalizeEmail } from '../lib/auth';
import { sessionSummary, startSession, ttlDariRequest } from '../lib/auth-session';
import { decideDevice, deviceIdFrom, deviceIdProblem, deviceNameFrom, rememberDevice } from '../lib/auth-device';
import {
	closeOtp,
	countFailedOtpAttempts,
	findLiveOtp,
	findUserByEmail,
	markVerified,
	readDbNow,
	recordFailedOtpAttempt,
	shapeUser,
} from '../lib/auth-store';
import { readJsonBody, stringField } from '../lib/body';
import { fail, json } from '../lib/http';
import type { DbRoute } from '../lib/types';

interface Input {
	email: string;
	kode: string;
	ttlS: number;
	/** `MachineGuid` komputer yang meminta — sama seperti login. */
	deviceId: string;
	deviceName: string;
}

export const authVerifyRoute: DbRoute<Input> = {
	method: 'POST',
	path: '/api/auth/verify',
	token: 'none',
	requiresDb: true,
	prepare: async ({ request, url }) => {
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const email = normalizeEmail(stringField(parsed.value, 'email'));
		const kode = stringField(parsed.value, 'kode') || stringField(parsed.value, 'otp');

		if (!email || !kode) return fail(400, 'Field `email` dan `kode` wajib diisi.');
		if (!isValidEmail(email)) return fail(400, 'Bentuk email tidak sah.');
		// Kode selalu angka; panjangnya dijaga 4-6 sesuai batas yang dilayani.
		if (!/^\d{4,6}$/.test(kode)) return fail(400, 'Kode OTP harus 4-6 angka.');

		// Verifikasi adalah LANJUTAN login: kalau login menuntut identitas
		// komputer, verifikasi tidak boleh jadi celah yang melewatinya.
		const deviceId = deviceIdFrom(request, parsed.value);
		const masalahPerangkat = deviceIdProblem(deviceId);
		if (masalahPerangkat) return fail(400, masalahPerangkat, 'PERANGKAT_TIDAK_JELAS');

		const requested = ttlDariRequest(request, url);
		return {
			input: {
				email,
				kode,
				ttlS: requested,
				deviceId,
				deviceName: deviceNameFrom(request, parsed.value),
			},
		};
	},

	handle: async ({ env }, { email, kode, ttlS, deviceId, deviceName }, sql) => {
		const user = await findUserByEmail(sql, email);
		if (!user) return fail(401, 'Kode verifikasi salah atau sudah tidak berlaku.');

		const userId = String(user.user_id);
		const live = await findLiveOtp(sql, userId);

		// Tidak ada kode hidup: sudah dipakai, sudah kadaluarsa, atau belum
		// pernah diminta. Jawabannya sengaja sama dengan "kode salah".
		if (!live) {
			return fail(409, 'Tidak ada kode yang menunggu. Minta kode baru lewat kirim ulang OTP.', 'TIDAK_ADA_KODE');
		}

		const percobaanSalah = await countFailedOtpAttempts(sql, userId, live.id);
		if (percobaanSalah >= OTP_MAX_ATTEMPTS) {
			await closeOtp(sql, live.id);
			return fail(429, 'Terlalu banyak percobaan salah. Minta kode baru.', 'KODE_DIMATIKAN');
		}

		// ------------------------------------------------------------------
		// Kode salah: catat percobaan (satu baris penanda), dan kalau sudah
		// kelewat batas, kode dimatikan sekalian.
		// ------------------------------------------------------------------
		if (String(live.otp_code) !== kode) {
			await recordFailedOtpAttempt(sql, userId);
			const sisa = OTP_MAX_ATTEMPTS - (percobaanSalah + 1);
			if (sisa <= 0) {
				await closeOtp(sql, live.id);
				return fail(429, 'Kode dimatikan karena terlalu banyak percobaan salah. Minta kode baru.', 'KODE_DIMATIKAN');
			}
			return json(
				{
					ok: false,
					code: 'KODE_SALAH',
					error: 'Kode verifikasi salah.',
					sisa_percobaan: sisa,
				},
				401,
			);
		}

		// ------------------------------------------------------------------
		// Kode benar. Sebelum sesi dibuat, periksa KOMPUTER-nya — sama seperti
		// login. Kode OTP membuktikan kepemilikan email, bukan hak memakai
		// komputer ini; keduanya pemeriksaan yang berbeda.
		//
		// Kode yang sudah benar tetap DITUTUP walau komputernya ditolak:
		// memakai ulang kode yang sudah terbukti benar tidak ada gunanya, dan
		// menahannya hidup cuma memperpanjang umur kode di inbox.
		// ------------------------------------------------------------------
		await closeOtp(sql, live.id);

		const nowS = Math.floor((await readDbNow(sql)).getTime() / 1000);
		const device = await decideDevice(sql, userId, { device_id: deviceId, device_name: deviceName }, nowS);

		if (!device.ok) {
			return json(
				{
					ok: false,
					code: 'PERANGKAT_LAIN',
					error: 'Akun ini sudah terdaftar di komputer lain.',
					petunjuk: 'Beli Akses Baru dong, atau di rodok mas rusdi loh ya.',
				},
				403,
			);
		}

		await markVerified(sql, userId);

		if (device.perluDaftar && device.catatanBaru) {
			const tersimpan = await rememberDevice(sql, userId, device.catatanBaru);
			if (!tersimpan) {
				return fail(409, 'Data perangkat gagal disimpan karena ada perubahan bersamaan. Coba lagi.');
			}
		}

		const started = await startSession(sql, env, userId, user.password_hash, ttlS);

		// `user` di sini masih baris sebelum update, jadi is_verified-nya
		// ditimpa manual di respons.
		return json({
			ok: true,
			status: 'terverifikasi',
			user: { ...shapeUser(user), is_verified: true },
			session: sessionSummary(started, nowS),
			perangkat: device.perangkat
				? { device_name: device.perangkat.device_name, sumber: device.sumber }
				: { device_name: deviceName, sumber: 'baru' },
			machine_info_diminta: true,
		});
	},
};
