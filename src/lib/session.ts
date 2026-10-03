/**
 * Catatan sesi di dalam kolom `user.machine_info`.
 *
 * ============================================================================
 * KENAPA BEGINI
 * ============================================================================
 * Permintaannya: token punya masa berlaku per user, dan kalau tokennya tidak
 * valid lagi user di-force logout dan login ulang. Itu menuntut masa berlaku
 * disimpan di sisi SERVER — kalau tidak, client tinggal mengubah jam di
 * komputernya sendiri dan masa berlakunya hilang.
 *
 * Masalahnya: tidak boleh ada tabel/kolom baru. Maka tempatnya dicari di kolom
 * yang sudah ada dan memang sudah dipakai untuk data kiriman FE:
 * `user.machine_info` (teks bebas, nullable).
 *
 * Bentuk isinya satu objek JSON dengan TIGA bagian yang tidak saling menimpa:
 *
 *     {
 *       "sesi":      { "v": 1, "exp": 1730000000, "iat": 1729971200,
 *                      "fp": "…32 huruf: sidik jari kredensial…",
 *                      "th": "…32 huruf: md5(token)…" },
 *       "perangkat": { "device_id": "…MachineGuid…", "device_name": "GTX-01",
 *                      "terdaftar_pada": 1729971200,
 *                      "terakhir_masuk": 1729971200 },
 *       "mesin":     { "os": "Windows 11", "cpu": "…" }
 *     }
 *
 *   "sesi"      = milik Worker. Dibuat saat login, dibaca saat token diperiksa.
 *                 DIHAPUS saat logout.
 *   "perangkat" = milik Worker. Komputer yang terdaftar untuk akun ini.
 *                 TIDAK dihapus saat logout — lihat catatan di bawah.
 *   "mesin"     = milik FE. Ditulis lewat POST /api/auth/machine setelah login.
 *
 * ============================================================================
 * KENAPA "perangkat" TIDAK BOLEH TINGGAL DI DALAM "sesi"
 * ============================================================================
 * Aturan produk: satu akun hidup di satu komputer saja, dan login dari
 * komputer lain DITOLAK. Aturan itu menuntut daftar perangkat BERTAHAN
 * melewati logout — sedangkan logout justru menghapus `sesi`. Kalau
 * `device_id` dititipkan di dalam `sesi`, alurnya jadi begini:
 *
 *     login di komputer A -> perangkat A terdaftar
 *     logout               -> catatan sesi (termasuk device_id) ikut terhapus
 *     login di komputer B  -> tidak ada perangkat terdaftar -> B didaftarkan
 *                             -> aturan "satu komputer" hilang begitu saja
 *
 * Jadi `perangkat` adalah kunci SAUDARA `sesi`, dan hanya `sesi` yang dibuang
 * saat logout (lihat withoutSession).
 *
 * ============================================================================
 * DUA TINGKAT: CATATAN PEMULIHAN MENANG
 * ============================================================================
 * `perangkat` di sini adalah catatan LOGIN. Ada satu catatan lagi di tabel
 * `recovery_user.machine_info` — catatan PEMULIHAN, diisi saat kode pemulihan
 * dari admin dipakai untuk memindahkan akun ke komputer lain.
 *
 * Kalau catatan pemulihan sudah berisi, ISI ITU YANG MENANG dan catatan login
 * tidak dipakai sama sekali. Aturan pemilihannya ada di perangkatSah(), dan
 * fungsi itu WAJIB dipakai di tiga tempat yang sama: login, pemulihan, dan
 * pemeriksaan sesi. Kalau salah satu memakai catatan login sendiri, pengguna
 * yang baru berhasil memulihkan akan langsung tertolak di login berikutnya.
 *
 * `th` (token hash) adalah kunci yang membuat aplikasi desktop bisa menyimpan
 * HANYA sidik jari MD5-nya — bukan token aslinya. Saat desktop mengirim sidik
 * jari itu, Worker membandingkannya dengan `th`; jadi sidik jari yang tersimpan
 * di komputer user tetap bisa dicabut, tanpa tabel sesi.
 *
 * Kalau `machine_info` sudah berisi teks bebas dari kode lama (bukan objek
 * JSON), teks itu TIDAK dibuang — tetap dibaca sebagai isi "mesin". Jadi tidak
 * ada data user yang hilang saat kode baru dipasang.
 *
 * CATATAN: masa berlaku ditulis dalam detik UNIX, dan yang dipegang selalu
 * `sesi.exp` — bukan jam komputer user.
 */

import {
	MACHINE_DEVICE_KEY,
	MACHINE_INFO_KEY,
	MACHINE_SESSION_KEY,
	MACHINE_SESSION_VERSION,
	MAX_DEVICE_ID_LENGTH,
	MAX_DEVICE_NAME_LENGTH,
	MAX_MACHINE_INFO_LENGTH,
} from "../config";
import { constantTimeEqual, credentialFingerprint } from "./auth";

/** Catatan sesi yang disimpan Worker di dalam `machine_info`. */
export interface SessionRecord {
	/** Versi bentuk catatan. Naikkan kalau bentuknya berubah. */
	v: number;
	/** Waktu kadaluarsa (detik UNIX). Sumber kebenaran masa berlaku token. */
	exp: number;
	/** Kapan sesi ini dibuat (detik UNIX). */
	iat: number;
	/** Sidik jari kredensial — lihat credentialFingerprint() di lib/auth.ts. */
	fp: string;
	/** Sidik jari token (md5) — inilah yang boleh disimpan aplikasi desktop. */
	th: string;
}

/**
 * Catatan perangkat: komputer mana yang terdaftar untuk akun ini.
 *
 * Disimpan di kunci `perangkat` — SAUDARA `sesi`, bukan isinya. Lihat catatan
 * panjang di kepala file ini soal alasannya.
 */
export interface DeviceRecord {
	/** `MachineGuid` komputer. Pembanding utama saat login dan tiap request. */
	device_id: string;
	/** Nama komputer Windows, untuk ditampilkan di halaman Pengaturan. */
	device_name: string;
	/** Kapan perangkat ini didaftarkan (detik UNIX). */
	terdaftar_pada: number;
	/** Kapan perangkat ini terakhir dipakai login (detik UNIX). */
	terakhir_masuk: number;
}

/** Isi `machine_info` setelah diurai. */
export interface MachineParts {
	/** Catatan sesi, null kalau user belum pernah login / sesinya sudah dibersihkan. */
	sesi: SessionRecord | null;
	/** Catatan perangkat (hasil login), null kalau akun ini belum punya perangkat. */
	perangkat: DeviceRecord | null;
	/** Informasi komputer kiriman FE, apa adanya, null kalau belum pernah dikirim. */
	mesin: unknown;
	/** Sisa kunci lain yang tidak dikenal (dijaga supaya tidak hilang). */
	lain: Record<string, unknown>;
}

/**
 * Sidik jari kredensial dipakai bersama token: satu definisi saja, yaitu
 * `credentialFingerprint()` di lib/auth.ts. Kalau dihitung di dua tempat dengan
 * cara berbeda, catatan sesi dan token tidak akan pernah cocok.
 *
 * `sesi.fp` disimpan PENUH (32 huruf), sama seperti yang ada di dalam token,
 * supaya perbandingannya tinggal "sama atau tidak".
 */

/** Kapan saja bisa dipanggil ulang (detik UNIX). */
export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Urai `machine_info`.
 *
 * Sengaja tidak pernah melempar error: kolom ini bisa berisi apa saja dari
 * versi kode sebelumnya, dan login tidak boleh gagal gara-gara itu.
 */
export function readMachineParts(raw: string | null): MachineParts {
	const empty: MachineParts = { sesi: null, perangkat: null, mesin: null, lain: {} };
	if (typeof raw !== "string" || !raw.trim()) return empty;

	const text = raw.trim();

	// Teks bebas dari kode lama: TIDAK dibuang, dianggap isi "mesin" apa adanya.
	if (!text.startsWith("{")) {
		return { sesi: null, perangkat: null, mesin: text, lain: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { sesi: null, perangkat: null, mesin: text, lain: {} };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { sesi: null, perangkat: null, mesin: parsed, lain: {} };
	}

	const obj = parsed as Record<string, unknown>;
	const lain: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === MACHINE_SESSION_KEY || key === MACHINE_INFO_KEY || key === MACHINE_DEVICE_KEY) {
			continue;
		}
		lain[key] = value;
	}

	return {
		sesi: parseSession(obj[MACHINE_SESSION_KEY]),
		perangkat: parseDevice(obj[MACHINE_DEVICE_KEY]),
		mesin: obj[MACHINE_INFO_KEY] ?? null,
		lain,
	};
}

/** Terima hanya bentuk catatan sesi yang masuk akal. */
function parseSession(value: unknown): SessionRecord | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;

	const exp = Number(obj.exp);
	const iat = Number(obj.iat);
	const fp = typeof obj.fp === "string" ? obj.fp : "";
	const th = typeof obj.th === "string" ? obj.th : "";
	if (!Number.isFinite(exp) || exp <= 0) return null;
	if (!Number.isFinite(iat) || iat < 0) return null;
	if (!/^[0-9a-f]{8,64}$/.test(fp)) return null;
	if (!/^[0-9a-f]{8,64}$/.test(th)) return null;

	return {
		v: Number(obj.v) || MACHINE_SESSION_VERSION,
		exp: Math.trunc(exp),
		iat: Math.trunc(iat),
		fp,
		th,
	};
}

/** Terima hanya bentuk catatan perangkat yang masuk akal. */
function parseDevice(value: unknown): DeviceRecord | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;

	const deviceId = typeof obj.device_id === "string" ? obj.device_id.trim() : "";
	if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) return null;

	const deviceName = typeof obj.device_name === "string" ? obj.device_name.trim() : "";
	const terdaftar = Number(obj.terdaftar_pada);
	const terakhir = Number(obj.terakhir_masuk);

	return {
		device_id: deviceId,
		device_name: deviceName.slice(0, MAX_DEVICE_NAME_LENGTH),
		terdaftar_pada: Number.isFinite(terdaftar) && terdaftar > 0 ? Math.trunc(terdaftar) : 0,
		terakhir_masuk: Number.isFinite(terakhir) && terakhir > 0 ? Math.trunc(terakhir) : 0,
	};
}

/** Susun ulang `machine_info` dari bagian-bagiannya. */
export function buildMachineParts(parts: MachineParts): string {
	const obj: Record<string, unknown> = { ...parts.lain };
	if (parts.sesi) obj[MACHINE_SESSION_KEY] = parts.sesi;
	if (parts.perangkat) obj[MACHINE_DEVICE_KEY] = parts.perangkat;
	if (parts.mesin !== null && parts.mesin !== undefined && parts.mesin !== "") {
		obj[MACHINE_INFO_KEY] = parts.mesin;
	}
	return JSON.stringify(obj);
}

/** Pasang catatan sesi baru, informasi komputer yang lama tetap utuh. */
export function withSession(raw: string | null, sesi: SessionRecord): string {
	return buildMachineParts({ ...readMachineParts(raw), sesi });
}

/** Simpan informasi komputer dari FE, catatan sesi tetap utuh. */
export function withMachineInfo(raw: string | null, mesin: unknown): string {
	return buildMachineParts({ ...readMachineParts(raw), mesin });
}

/** Pasang catatan perangkat, bagian lain tetap utuh. */
export function withDevice(raw: string | null, perangkat: DeviceRecord): string {
	return buildMachineParts({ ...readMachineParts(raw), perangkat });
}

/**
 * Buang catatan sesi (dipakai saat logout / force logout).
 *
 * PENTING: `perangkat` SENGAJA tidak ikut dibuang. Aturan "satu akun satu
 * komputer" harus tetap berlaku setelah logout — kalau daftar perangkat ikut
 * terhapus di sini, siapa pun yang tahu password bisa pindah komputer cukup
 * dengan meminta pemiliknya logout. Lihat catatan di kepala file ini.
 */
export function withoutSession(raw: string | null): string {
	return buildMachineParts({ ...readMachineParts(raw), sesi: null });
}

/** Apakah catatan perangkat menunjuk ke komputer ini. */
export function deviceMatches(perangkat: DeviceRecord | null, deviceId: string): boolean {
	if (!perangkat) return false;
	return constantTimeEqual(perangkat.device_id, deviceId.trim());
}

/** Apakah akun ini sudah punya perangkat terdaftar. */
export function hasDevice(perangkat: DeviceRecord | null): boolean {
	return perangkat !== null && perangkat.device_id.length > 0;
}

/**
 * Pilih catatan perangkat mana yang BERLAKU untuk sebuah akun.
 *
 * Aturannya satu baris, tapi wajib dipakai seragam di login, pemulihan, dan
 * pemeriksaan sesi:
 *
 *     catatan pemulihan (recovery_user.machine_info)  -> kalau ada isinya
 *     catatan login     (user.machine_info.perangkat) -> kalau catatan pemulihan masih NULL
 *
 * Catatan pemulihan yang sudah berisi TIDAK PERNAH ditimpa dan tidak pernah
 * dikalahkan — termasuk oleh catatan login akun itu sendiri. Itulah yang
 * menjaga "satu akun satu komputer" tetap berlaku setelah perpindahan.
 */
export function perangkatSah(
	loginDevice: DeviceRecord | null,
	recoveryDevice: DeviceRecord | null,
): { perangkat: DeviceRecord | null; sumber: "pemulihan" | "login" | "kosong" } {
	if (hasDevice(recoveryDevice)) return { perangkat: recoveryDevice, sumber: "pemulihan" };
	if (hasDevice(loginDevice)) return { perangkat: loginDevice, sumber: "login" };
	return { perangkat: null, sumber: "kosong" };
}

/**
 * Urai `machine_info` di tabel `recovery_user` menjadi catatan perangkat.
 *
 * Isinya ditulis worker ini sendiri (lihat lib/auth-recovery.ts), tapi tetap
 * diurai dengan hati-hati: kolomnya bisa diisi proses lain (pembuatan akun),
 * dan isi yang tidak dikenali harus berakhir "tidak ada perangkat", bukan
 * membuat login gagal dengan error.
 */
export function parseRecoveryDevice(raw: string | null): DeviceRecord | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const text = raw.trim();
	if (!text.startsWith("{")) return null;
	try {
		return parseDevice(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * Cocokkan catatan sesi dengan token yang dibawa client (jalur token penuh).
 *
 * Yang dibandingkan dua-duanya TIDAK BISA diubah client:
 *   exp -> token harus kadaluarsa pada saat yang sama dengan catatan sesi
 *   fp  -> kredensial (password) tidak berubah sejak token dibuat
 *
 * `exp` di dalam token ditahan tanda tangannya: memperpanjang `exp` di sisi
 * client merusak tanda tangan, sedangkan memperpanjang di catatan sesi butuh
 * akses database.
 */
export function sessionMatches(
	sesi: SessionRecord | null,
	token: { exp: number; fingerprint: string },
): boolean {
	if (!sesi) return false;
	if (sesi.exp !== token.exp) return false;
	if (sesi.fp !== token.fingerprint) return false;
	return true;
}

/**
 * Cocokkan catatan sesi dengan SIDIK JARI token (jalur aplikasi desktop).
 *
 * Aplikasi desktop menyimpan hanya `md5(token)`, lalu mengirimkannya bersama
 * `user_id`. Jadi token aslinya tidak perlu ikut dititipkan di komputer user,
 * tapi sesinya tetap bisa diperiksa dan dicabut dari sisi Worker:
 *
 *   - `th`  harus sama dengan sidik jari md5(token) yang dikirim desktop
 *             -> memang token inilah yang diterbitkan saat login;
 *   - `fp`  harus sama dengan md5(password_hash sekarang)    -> ganti password
 *             = semua perangkat langsung tertendang;
 *   - `exp` harus masih di depan `nowDbS` (waktu DATABASE).
 *
 * Pemeriksaan `fp` di sini tidak butuh token aslinya, dan itulah sebabnya
 * jalur ini bisa bekerja dengan hanya sidik jari.
 */
export function sessionAcceptsFingerprint(
	sesi: SessionRecord | null,
	providedHash: string,
	credentialFp: string,
	nowDbS: number,
): boolean {
	if (!sesi) return false;
	if (!constantTimeEqual(sesi.th, providedHash)) return false;
	if (!constantTimeEqual(sesi.fp, credentialFp)) return false;
	return sesi.exp > nowDbS;
}

/** Apakah sesi sudah lewat masa berlakunya, menurut waktu yang diberikan. */
export function sessionExpired(sesi: SessionRecord, nowS: number): boolean {
	return sesi.exp <= nowS;
}

/** Sisa masa berlaku sesi (detik); bisa negatif kalau sudah lewat. */
export function sessionRemainingS(sesi: SessionRecord, nowS: number): number {
	return sesi.exp - nowS;
}

/** Apakah isi `machine_info` masih muat di kolom (byte). */
export function machineInfoFits(text: string): boolean {
	return new TextEncoder().encode(text).length <= MAX_MACHINE_INFO_LENGTH;
}
