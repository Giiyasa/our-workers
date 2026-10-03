/**
 * Identitas perangkat: memutuskan komputer mana yang boleh masuk.
 *
 * Aturan produknya keras (keputusan D2, "tolak mutlak"): satu akun hidup di
 * SATU komputer. Tidak ada jalan pindah lewat password — satu-satunya jalan
 * adalah kode pemulihan dari admin.
 *
 * ============================================================================
 * SATU TEMPAT UNTUK ATURAN YANG PALING GAMPANG SALAH
 * ============================================================================
 * "Komputer mana yang sah untuk akun ini" dihitung dari DUA catatan, dan
 * urutannya tidak boleh dibalik:
 *
 *     catatan pemulihan (recovery_user.machine_info)  -> kalau ada isinya
 *     catatan login     (user.machine_info.perangkat) -> kalau catatan pemulihan NULL
 *
 * Aturan itu hidup di satu fungsi murni (`perangkatSah()` di lib/session.ts),
 * dan modul ini yang membacakan kedua catatan itu dari database. Login (W2),
 * pemulihan (W9), dan pemeriksaan sesi (W4) memakai modul ini — bukan membaca
 * `user.machine_info` sendiri-sendiri. Kalau salah satu menyimpang, pengguna
 * yang baru berhasil memulihkan akan langsung tertolak di login berikutnya
 * karena catatan login-nya masih menyebut komputer lama.
 *
 * ============================================================================
 * KENAPA device_id WAJIB DI SETIAP REQUEST, BUKAN CUMA SAAT LOGIN
 * ============================================================================
 * Memeriksa perangkat hanya saat login tidak menahan apa pun: berkas sesi
 * (`token_hash`) yang disalin ke komputer lain akan lolos, karena komputer
 * tujuan tidak pernah ditanya "kamu siapa". Karena itu `machine_info` di
 * server menyimpan `device_id`, dan pemeriksaan sesi membandingkannya dengan
 * header `X-Device-Id` yang dikirim aplikasi tiap kali memanggil API.
 */

import {
	DEVICE_ID_HEADER,
	DEVICE_NAME_HEADER,
	MAX_DEVICE_ID_LENGTH,
	MAX_DEVICE_NAME_LENGTH,
	MIN_DEVICE_ID_LENGTH,
} from "../config";
import { readRecoveryDevice } from "./auth-recovery";
import { readMachineInfo, saveMachineInfoIf } from "./auth-store";
import type { Sql } from "./db";
import {
	machineInfoFits,
	perangkatSah,
	readMachineParts,
	withDevice,
	type DeviceRecord,
} from "./session";

/** Identitas komputer yang dikirim aplikasi. */
export interface DeviceInput {
	device_id: string;
	device_name: string;
}

/**
 * Ambil `device_id` dari body, lalu header.
 *
 * Body lebih dulu karena itu jalur yang dipakai aplikasi desktop saat login
 * (satu permintaan JSON); header disediakan untuk rute yang tidak punya body
 * (GET /me) dan untuk alat uji.
 */
export function deviceIdFrom(request: Request, body?: Record<string, unknown>): string {
	const dariBody = body ? body.device_id : undefined;
	if (typeof dariBody === "string" && dariBody.trim()) return dariBody.trim().slice(0, MAX_DEVICE_ID_LENGTH);
	if (typeof dariBody === "number" && Number.isFinite(dariBody)) return String(dariBody).slice(0, MAX_DEVICE_ID_LENGTH);
	return (request.headers.get(DEVICE_ID_HEADER) ?? "").trim().slice(0, MAX_DEVICE_ID_LENGTH);
}

/** Ambil `device_name` dari body, lalu header. Boleh kosong. */
export function deviceNameFrom(request: Request, body?: Record<string, unknown>): string {
	const dariBody = body ? body.device_name : undefined;
	if (typeof dariBody === "string" && dariBody.trim()) return dariBody.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
	return (request.headers.get(DEVICE_NAME_HEADER) ?? "").trim().slice(0, MAX_DEVICE_NAME_LENGTH);
}

/**
 * Periksa bentuk `device_id`.
 *
 * Mengembalikan pesan penolakan, atau null kalau bentuknya bisa dipakai.
 * Panjang minimum 8 huruf: nilai lebih pendek dari itu (mis. "1", "abc")
 * hampir pasti bug aplikasi, bukan `MachineGuid` — dan bug yang lolos ke sini
 * akan mendaftarkan SEMUA komputer yang kebetulan mengirim nilai sama ke satu
 * perangkat.
 */
export function deviceIdProblem(deviceId: string): string | null {
	if (!deviceId) return `Header/field \`device_id\` wajib diisi (${DEVICE_ID_HEADER}).`;
	if (deviceId.length < MIN_DEVICE_ID_LENGTH) {
		return `Nilai \`device_id\` terlalu pendek (minimum ${MIN_DEVICE_ID_LENGTH} karakter).`;
	}
	if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
		return `Nilai \`device_id\` terlalu panjang (maksimum ${MAX_DEVICE_ID_LENGTH} karakter).`;
	}
	return null;
}

/**
 * Hasil pemeriksaan perangkat.
 *
 * `terdaftar: true` berarti perangkat ini baru dicatat pada permintaan ini —
 * pemanggil wajib menulisnya ke `user.machine_info.perangkat`.
 */
export interface DeviceDecision {
	ok: boolean;
	/** Kode penolakan untuk body respons (`PERANGKAT_LAIN`). */
	code?: "PERANGKAT_LAIN";
	/** Kode penolakan bentuk (bukan perangkat terdaftar) — 400, bukan 403. */
	masalah?: string;
	/** Perangkat yang sah menurut aturan dua tingkat. */
	perangkat: DeviceRecord | null;
	/** Dari catatan mana perangkat sah itu dibaca. */
	sumber: "pemulihan" | "login" | "kosong";
	/**
	 * true = catatan perangkat perlu ditulis (baru, atau waktunya diperbarui).
	 * Pemanggil yang menentukan kapan menulis, supaya penulisan sesi dan
	 * penulisan perangkat terjadi di satu putaran bandingkan-lalu-tulis.
	 */
	perluDaftar: boolean;
	/** Catatan perangkat yang wajar ditulis ke `user.machine_info.perangkat`. */
	catatanBaru: DeviceRecord | null;
}

/**
 * Putuskan apakah sebuah komputer boleh dipakai untuk masuk.
 *
 * Dipakai login (W2), verifikasi OTP (lanjutan login), dan pemulihan (W9).
 *
 * Aturannya:
 *   - catatan pemulihan ada isinya  -> hanya komputer itu (catatan login
 *                                      diabaikan sepenuhnya)
 *   - catatan pemulihan NULL        -> catatan login yang menentukan
 *   - keduanya kosong               -> komputer pertama yang mendaftar
 *
 * Perhatikan arah penolakannya sengaja TIDAK selalu 403: kalau `device_id`
 * bentuknya ngawur (kosong / kepanjangan), itu bukan "komputer lain", itu
 * permintaan rusak — jadi 400. Membedakannya penting: 403 memancing pengguna
 * menempuh alur pemulihan yang panjang untuk masalah yang bukan tentang
 * perangkat.
 */
export async function decideDevice(
	sql: Sql,
	userId: string,
	input: DeviceInput,
	nowS: number,
): Promise<DeviceDecision> {
	const [login, pemulihan] = await Promise.all([
		readLoginDevice(sql, userId),
		readRecoveryDevice(sql, userId),
	]);
	const sah = perangkatSah(login, pemulihan);

	if (!sah.perangkat) {
		// Belum ada catatan perangkat sama sekali: komputer ini yang pertama.
		return {
			ok: true,
			perangkat: null,
			sumber: "kosong",
			perluDaftar: true,
			catatanBaru: buatCatatan(input, nowS),
		};
	}

	if (sah.perangkat.device_id !== input.device_id) {
		return {
			ok: false,
			code: "PERANGKAT_LAIN",
			perangkat: sah.perangkat,
			sumber: sah.sumber,
			perluDaftar: false,
			catatanBaru: null,
		};
	}

	// Komputer yang sama. Catatan diperbarui supaya "terakhir masuk" dan nama
	// komputer ikut segar — tapi kalau perangkat sahnya dari catatan
	// PEMULIHAN, `user.machine_info.perangkat` tidak boleh disentuh (§5.5:
	// catatan pemulihan tidak pernah ditimpa, catatan login tidak diubah).
	return {
		ok: true,
		perangkat: sah.perangkat,
		sumber: sah.sumber,
		perluDaftar: sah.sumber === "login",
		catatanBaru: sah.sumber === "login" ? perbaruiCatatan(sah.perangkat, input, nowS) : null,
	};
}

/**
 * Catat komputer ini sebagai perangkat akun, TANPA menyentuh catatan sesi.
 *
 * Dipakai saat login/verifikasi/pemulihan sudah lolos pemeriksaan perangkat
 * tapi `user.machine_info.perangkat` belum menunjuk komputer ini. Penulisan
 * memakai pola bandingkan-lalu-tulis dengan percobaan ulang, sama seperti
 * penulisan catatan sesi — kalau tidak, penulisan ini bisa menghapus sesi yang
 * baru saja dibuat permintaan lain.
 *
 * Mengembalikan false kalau kolomnya berubah terus (pemanggil memutuskan
 * apakah itu menggagalkan login atau cukup dilewati).
 */
export async function rememberDevice(
	sql: Sql,
	userId: string,
	catatan: DeviceRecord,
): Promise<boolean> {
	let tersimpan = false;
	for (let attempt = 0; attempt < 3 && !tersimpan; attempt++) {
		const current = await readMachineInfo(sql, userId);
		const next = withDevice(current, catatan);
		if (!machineInfoFits(next)) return false;
		tersimpan = await saveMachineInfoIf(sql, userId, current, next);
	}
	return tersimpan;
}

/**
 * Periksa `device_id` permintaan untuk rute yang hanya butuh bentuknya benar.
 *
 * Dipakai pemulihan SEBELUM baris pemulihan dicari: kalau `device_id`-nya
 * ngawur, jangan sampai percobaan itu tercatat sebagai percobaan gagal —
 * itu akan memakan jatah percobaan pengguna tanpa alasan.
 */
export function deviceInputProblem(input: DeviceInput): string | null {
	return deviceIdProblem(input.device_id);
}

/** Susun catatan perangkat baru. */
function buatCatatan(input: DeviceInput, nowS: number): DeviceRecord {
	return {
		device_id: input.device_id,
		device_name: input.device_name,
		terdaftar_pada: nowS,
		terakhir_masuk: nowS,
	};
}

/** Perbarui catatan perangkat yang sudah ada, waktu daftar aslinya dipertahankan. */
function perbaruiCatatan(lama: DeviceRecord, input: DeviceInput, nowS: number): DeviceRecord {
	return {
		device_id: lama.device_id,
		device_name: input.device_name || lama.device_name,
		terdaftar_pada: lama.terdaftar_pada || nowS,
		terakhir_masuk: nowS,
	};
}

/** Catatan login (`user.machine_info.perangkat`) — satu kunci di antara tiga. */
async function readLoginDevice(sql: Sql, userId: string): Promise<DeviceRecord | null> {
	const parts = readMachineParts(await readMachineInfo(sql, userId));
	return parts.perangkat ?? null;
}
