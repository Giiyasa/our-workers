/**
 * POST /api/auth/recovery
 *
 * Pindahkan akun ke komputer ini memakai kode pemulihan dari admin.
 *
 * Ini SATU-SATUNYA jalan pindah komputer. Tidak ada pintu lewat password —
 * keputusan D2 "tolak mutlak": akun terikat pada satu komputer, dan yang boleh
 * mengubah ikatan itu hanya kode yang diterbitkan admin.
 *
 * ============================================================================
 * URUTAN YANG MUTLAK — jangan diubah tanpa membaca ini
 * ============================================================================
 *   1. cari user dari email
 *   2. cari baris `recovery_user` (user + kode)
 *   3. periksa batas percobaan
 *   4. TULIS catatan pemulihan kalau masih NULL; kalau sudah berisi dan
 *      `device_id` peminta BEDA -> 403 PERANGKAT_LAIN, BERHENTI DI SINI
 *   5. baru tandai `is_used = true`
 *   6. buat sesi baru (sesi lama di komputer lama otomatis mati)
 *
 * Langkah 4 mendahului langkah 5, dan itu intinya: kode yang DITOLAK karena
 * berbeda komputer TIDAK terbakar, sehingga pengguna yang salah komputer masih
 * bisa memakai kode yang sama di komputer yang benar. Kalau urutannya dibalik,
 * satu salah ketik/ salah komputer = kode hangus, dan pengguna harus meminta
 * kode baru ke admin.
 *
 * ============================================================================
 * `user.machine_info` TIDAK DISENTUH
 * ============================================================================
 * Proses ini hanya mengubah dua hal: baris `recovery_user` (langkah 4–5) dan
 * kunci `sesi` di `user.machine_info` (langkah 6). Kunci `perangkat` dan
 * `mesin` dibiarkan apa adanya.
 *
 * Konsekuensinya disengaja: setelah pemulihan, catatan login masih menyebut
 * komputer LAMA. Karena catatan pemulihan yang menang (perangkatSah), komputer
 * lama otomatis tertolak, dan komputer baru langsung sah. Kalau catatan login
 * ikut ditimpa, "catatan pemulihan yang menang" cuma jadi teori — kedua
 * catatan akan selalu sama, dan tidak ada lagi cara membedakan mana yang
 * berlaku.
 *
 * ============================================================================
 * BENTUK JAWABAN YANG DISAMAKAN
 * ============================================================================
 * "email tidak terdaftar" dan "kode salah" dijawab dengan bentuk yang sama
 * (401 KODE_PEMULIHAN_SALAH). Kalau dibedakan, rute ini jadi alat untuk
 * memeriksa email mana yang punya akun — dan hanya butuh kode ngawur untuk
 * mengetesnya.
 */

import { RECOVERY_ATTEMPT_WINDOW_S, RECOVERY_MAX_ATTEMPTS } from "../config";
import { isValidEmail, normalizeEmail } from "../lib/auth";
import { sessionSummary, startSession, ttlDariRequest } from "../lib/auth-session";
import {
	claimRecoveryRow,
	countFailedRecoveryAttempts,
	findRecoveryRow,
	isClaimCancelled,
	recoveryMachineInfo,
	recordFailedRecoveryAttempt,
	recoveryRetryAfterS,
} from "../lib/auth-recovery";
import { deviceIdFrom, deviceNameFrom, deviceInputProblem } from "../lib/auth-device";
import { findUserByEmail, markVerified, readDbNow, shapeUser } from "../lib/auth-store";
import { readJsonBody, stringField } from "../lib/body";
import { fail, json } from "../lib/http";
import { parseRecoveryDevice, type DeviceRecord } from "../lib/session";
import type { DbRoute } from "../lib/types";

interface Input {
	email: string;
	/** Kode pemulihan dari admin, angka. */
	recoveryKey: string;
	ttlS: number;
	deviceId: string;
	deviceName: string;
}

export const authRecoveryRoute: DbRoute<Input> = {
	method: "POST",
	path: "/api/auth/recovery",
	token: "none",
	requiresDb: true,

	prepare: async ({ request, url }) => {
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const email = normalizeEmail(stringField(parsed.value, "email"));
		// Diterima dengan beberapa nama: `recovery_key` (nama kolomnya),
		// `kode`, dan `kode_pemulihan` (istilah yang dipakai layar Pemulihan).
		const recoveryKey =
			stringField(parsed.value, "recovery_key") ||
			stringField(parsed.value, "kode") ||
			stringField(parsed.value, "kode_pemulihan");

		if (!email || !recoveryKey) return fail(400, "Field `email` dan `recovery_key` wajib diisi.");
		if (!isValidEmail(email)) return fail(400, "Bentuk email tidak sah.");
		// Hanya angka. Kolomnya int4, jadi huruf apa pun tidak akan pernah cocok
		// dengan baris mana pun — ditolak di sini supaya tidak menghabiskan
		// jatah percobaan pengguna karena salah ketik.
		if (!/^\d{1,10}$/.test(recoveryKey)) return fail(400, "Kode pemulihan harus berupa angka.");

		// Bentuk perangkat diperiksa SEBELUM baris pemulihan dicari: percobaan
		// yang tidak bisa dilanjutkan sama sekali tidak boleh tercatat sebagai
		// percobaan gagal.
		const deviceId = deviceIdFrom(request, parsed.value);
		const masalahPerangkat = deviceInputProblem({ device_id: deviceId, device_name: "" });
		if (masalahPerangkat) return fail(400, masalahPerangkat, "PERANGKAT_TIDAK_JELAS");

		const requested = ttlDariRequest(request, url);
		return {
			input: {
				email,
				recoveryKey,
				ttlS: requested,
				deviceId,
				deviceName: deviceNameFrom(request, parsed.value),
			},
		};
	},

	handle: async ({ env }, { email, recoveryKey, ttlS, deviceId, deviceName }, sql) => {
		const user = await findUserByEmail(sql, email);

		// ------------------------------------------------------------------
		// Email tidak terdaftar.
		//
		// Dijawab dengan BENTUK YANG SAMA seperti kode salah, termasuk sisa
		// percobaannya. Tidak ada percobaan yang dicatat (tidak ada user yang
		// bisa dihitung), jadi angkanya pun tidak bisa dibedakan.
		// ------------------------------------------------------------------
		if (!user) {
			return kodeSalah(RECOVERY_MAX_ATTEMPTS - 1);
		}

		const userId = String(user.user_id);

		// ------------------------------------------------------------------
		// Batas percobaan — diperiksa SEBELUM kodenya dicari.
		//
		// Urutannya begitu supaya tebakan yang sedang kehabisan jatah tidak
		// bisa dipakai mengukur apa pun: jawabannya sama saja, kode benar atau
		// salah, sampai jendelanya lewat.
		// ------------------------------------------------------------------
		const gagalSebelumnya = await countFailedRecoveryAttempts(sql, userId, RECOVERY_ATTEMPT_WINDOW_S);
		if (gagalSebelumnya >= RECOVERY_MAX_ATTEMPTS) {
			const tunggu = await recoveryRetryAfterS(sql, userId, RECOVERY_ATTEMPT_WINDOW_S);
			return json(
				{
					ok: false,
					code: "TUNGGU_SEBENTAR",
					error: `Terlalu banyak percobaan kode pemulihan. Coba lagi dalam ${tunggu} detik.`,
					tunggu_detik: tunggu,
				},
				429,
			);
		}

		const nowS = Math.floor((await readDbNow(sql)).getTime() / 1000);
		const baris = await findRecoveryRow(sql, userId, recoveryKey);

		if (!baris) {
			await recordFailedRecoveryAttempt(sql, userId);
			return kodeSalah(RECOVERY_MAX_ATTEMPTS - (gagalSebelumnya + 1));
		}

		// Kode benar tapi sudah dipakai. Ini pembedaan yang disengaja: pengguna
		// yang memegang kode benar tidak perlu menghabiskan sisa percobaannya
		// menebak-nebak, dan TIDAK dicatat sebagai percobaan gagal.
		if (baris.is_used) {
			return json(
				{
					ok: false,
					code: "KODE_PEMULIHAN_TERPAKAI",
					error: "Kode ini sudah pernah dipakai. Minta kode baru ke admin.",
				},
				409,
			);
		}

		const catatanBaru: DeviceRecord = {
			device_id: deviceId,
			device_name: deviceName,
			terdaftar_pada: nowS,
			terakhir_masuk: nowS,
		};

		// ------------------------------------------------------------------
		// Langkah 4 — inilah tempat urutan itu penting.
		// ------------------------------------------------------------------
		const isiLama = baris.machine_info;

		if (isiLama === null) {
			// Baris polos: catatan perangkat ditulis, lalu ditandai terpakai.
			const tersimpan = await klaim(sql, baris.id, null, catatanBaru);
			if (!tersimpan) return gagalBalapan();
			return pulih(sql, env, user, userId, catatanBaru, "pemulihan", ttlS, nowS);
		}

		// Catatan sudah berisi dari pemakaian sebelumnya.
		const perangkatLama = parseRecoveryDevice(isiLama);
		if (!perangkatLama) {
			// Isinya tidak dikenali (bukan JSON perangkat). Ini keadaan yang
			// tidak seharusnya terjadi — barisnya ditulis worker ini sendiri —
			// tapi lebih baik berhenti daripada menimpa catatan yang tidak
			// dipahami.
			return fail(
				409,
				"Catatan pemulihan baris ini tidak bisa dibaca. Minta kode baru ke admin.",
				"CATATAN_PEMULIHAN_RUSAK",
			);
		}

		if (perangkatLama.device_id !== deviceId) {
			// Komputer berbeda. Kode TIDAK dibakar (is_used tetap false), jadi
			// kode yang sama masih bisa dipakai di komputer yang benar.
			return json(
				{
					ok: false,
					code: "PERANGKAT_LAIN",
					error: "Akun ini sudah terdaftar di komputer lain lewat pemulihan sebelumnya.",
					petunjuk: "Minta kode pemulihan baru ke admin.",
				},
				403,
			);
		}

		// Komputer yang sama, memakai kode yang belum terbakar: jalan saja,
		// tanpa menulis ulang catatannya (isinya sudah benar).
		const tersimpan = await klaim(sql, baris.id, isiLama, catatanBaru);
		if (!tersimpan) return gagalBalapan();
		return pulih(sql, env, user, userId, perangkatLama, "pemulihan", ttlS, nowS);
	},
};

/** Jawaban "kode pemulihan salah", bentuknya tetap sama untuk semua sebab. */
function kodeSalah(sisa: number): Response {
	return json(
		{
			ok: false,
			code: "KODE_PEMULIHAN_SALAH",
			error: "Kode pemulihan salah.",
			sisa_percobaan: Math.max(0, sisa),
		},
		401,
	);
}

/** Baris pemulihan berubah di antara pembacaan dan penulisan. */
function gagalBalapan(): Response {
	return fail(409, "Data pemulihan berubah bersamaan. Coba lagi.", "PEMULIHAN_BALAPAN");
}

/**
 * Tulis catatan perangkat + kode terpakai dalam satu transaksi.
 *
 * Kalau transaksinya batal karena perubahan bersamaan (`isClaimCancelled`),
 * hasilnya false — bukan error 500. Pemanggil membalas 409 supaya pengguna
 * cukup menekan tombolnya sekali lagi.
 */
async function klaim(
	sql: Parameters<typeof claimRecoveryRow>[0],
	rowId: string,
	expectMachineInfo: string | null,
	catatan: DeviceRecord,
): Promise<boolean> {
	try {
		return await claimRecoveryRow(sql, rowId, expectMachineInfo, recoveryMachineInfo(catatan));
	} catch (err) {
		if (isClaimCancelled(err)) return false;
		throw err;
	}
}

/**
 * Langkah 6: sesi baru.
 *
 * Sekaligus menutup sesi lama secara alami — catatan `sesi` di
 * `user.machine_info` ditimpa, jadi `token_hash` yang masih tersimpan di
 * komputer lama tidak akan cocok lagi.
 *
 * Akun yang `is_verified = false` ikut diverifikasi: kode dari admin
 * setidaknya sekuat bukti kepemilikan email, dan menahan statusnya akan
 * membuat pengguna terjebak di layar OTP setelah berhasil memulihkan.
 */
async function pulih(
	sql: Parameters<typeof claimRecoveryRow>[0],
	env: Env,
	user: Awaited<ReturnType<typeof findUserByEmail>>,
	userId: string,
	perangkat: DeviceRecord,
	sumber: "pemulihan" | "login",
	ttlS: number,
	nowS: number,
): Promise<Response> {
	if (!user) return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");

	const started = await startSession(sql, env, userId, user.password_hash, ttlS);
	if (!user.is_verified) await markVerified(sql, userId);

	return json({
		ok: true,
		status: "pulih",
		user: { ...shapeUser(user), is_verified: true },
		session: sessionSummary(started, nowS),
		perangkat: { device_id: perangkat.device_id, device_name: perangkat.device_name, sumber },
		machine_info_diminta: true,
		petunjuk: "Komputer ini sekarang terdaftar. Komputer lama langsung terputus.",
	});
}
