/**
 * Perkakas auth: hash password, token akses, kode OTP.
 *
 * Semua fungsi murni/bebas-DB supaya bisa diuji tanpa database, dan supaya
 * rute cuma menyusun urutan pemanggilannya.
 *
 * ============================================================================
 * KENAPA PASSWORD TIDAK DI-HASH PAKAI MD5
 * ============================================================================
 * MD5 dirancang untuk kecepatan. Di GPU modern, miliaran tebakan per detik
 * itu wajar — dan tanpa salt, dua user berpassword sama menghasilkan hash
 * yang identik (tabel `user` langsung bisa "dibaca sekilas"). Karena kolom
 * `password_hash` di project ini belum pernah dipakai (masih kosong), tidak
 * ada data lama yang harus dijaga — jadi kolom yang sama kita isi dengan:
 *
 *     sha256-v1$<salt>$<sha256(salt + ":" + password)>
 *
 * Tetap satu kolom, tanpa tabel baru, tapi sidik jari tiap user berbeda.
 * SHA-256 bukan pengganti ideal bcrypt/argon2, tetapi jauh lebih baik dari MD5
 * dan tetap bisa dihitung di Worker dalam hitungan mikrodetik.
 *
 * MD5 tetap disediakan (`md5Hex`) dan DIPAKAI — bukan untuk password, tapi
 * untuk kode OTP: kodenya cuma hidup 5 menit, panjangnya sedikit bit, dan
 * yang penting kode mentahnya tidak tersimpan apa adanya di database.
 *
 * ============================================================================
 * TOKEN AKSES: DIPERIKSA SERVER, BUKAN FRONTEND
 * ============================================================================
 * Token TIDAK konstan dan TIDAK dibagi ke semua user. Isinya:
 *
 *     v1.<user_id>.<kadaluarsa-detik>.<tanda-tangan md5>.<sidik jari kredensial>
 *     tanda-tangan   = md5(user_id + "." + kadaluarsa + "." + AUTH_SECRET)
 *     sidik jari     = md5(password_hash)   <- 32 huruf, apa adanya
 *
 * Karena tokennya ditandatangani rahasia milik Worker, isinya tidak bisa
 * dipalsukan maupun diperpanjang sendiri oleh user: memperpanjang `exp`
 * merusak tanda tangannya. Token juga mengikat `user_id` dan sidik jari
 * `password_hash`, jadi ganti password = semua token lama langsung mati.
 *
 * Masa berlaku TIDAK disimpan di dalam token saja. Saat login, catatan sesi
 * ikut ditulis ke kolom `user.machine_info` (lihat lib/session.ts) berisi
 * `exp` dan sidik jari yang sama. Token yang lolos tanda tangan tetap ditolak
 * kalau (a) catatan sesinya sudah tidak ada — mis. habis logout, atau (b) masa
 * berlakunya di catatan itu sudah lewat. Inilah yang membuat force logout
 * benar-benar terjadi di server, tanpa tabel baru.
 *
 * Yang TIDAK dilindungi (dan tidak bisa, tanpa tabel sesi per-perangkat):
 * token yang sudah bocor tetap sah sampai masa berlakunya habis. Mencabutnya
 * sekarang = hapus catatan sesi user (endpoint logout) atau ganti password.
 */

import {
	AUTH_SECRET_DEV,
	MAX_EMAIL_LENGTH,
	PASSWORD_HASH_TAG,
	PASSWORD_SALT_BYTES,
} from "../config";

/** Nilai penanda apakah AUTH_SECRET asli sudah dipasang. */
export function resolveAuthSecret(env: Env): { secret: string; temporary: boolean } {
	const configured = typeof env.AUTH_SECRET === "string" ? env.AUTH_SECRET.trim() : "";
	if (configured) return { secret: configured, temporary: false };
	return { secret: AUTH_SECRET_DEV, temporary: true };
}

// ---------------------------------------------------------------------------
// Alat bantu bytes <-> teks
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
	return out;
}

export function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Bandingkan dua string tanpa membocorkan panjang/isi lewat waktu respons. */
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ---------------------------------------------------------------------------
// MD5 (implementasi sendiri — WebCrypto memang tidak menyediakan MD5)
// ---------------------------------------------------------------------------
//
// Dipakai untuk: tanda tangan token akses + sidik jari kode OTP.
// Ikut standar RFC 1321; hasilnya diperiksa terhadap vektor uji resmi di
// test/units.spec.ts ("", "abc", "message digest", string 1 juta "a").

// Konstanta K[i] = floor(abs(sin(i + 1)) * 2^32), digeser 32 bit.
const MD5_K = [
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

// Perputaran bit per ronde.
const MD5_S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotl(x: number, c: number): number {
	return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** Hitung MD5 dari byte apa pun, kembalikan 16 byte mentah. */
export function md5Bytes(input: Uint8Array): Uint8Array {
	// Padding RFC 1321: tambah 0x80, isi 0 sampai panjang ≡ 56 (mod 64),
	// lalu 8 byte panjang asli dalam satuan BIT (little-endian).
	const bitLen = input.length * 8;
	const withPad = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
	withPad.set(input);
	withPad[input.length] = 0x80;
	const view = new DataView(withPad.buffer);
	// Panjang bit ditulis 64-bit; JS aman sampai 2^53 bit (≈1 petabyte teks).
	view.setUint32(withPad.length - 8, bitLen >>> 0, true);
	view.setUint32(withPad.length - 4, Math.floor(bitLen / 0x1_0000_0000), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const m = new Uint32Array(16);
	for (let chunk = 0; chunk < withPad.length; chunk += 64) {
		for (let i = 0; i < 16; i++) m[i] = view.getUint32(chunk + i * 4, true);

		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;

		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}

			const rotated = rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i]);
			const next = (b + rotated) >>> 0;
			a = d;
			d = c;
			c = b;
			b = next;
		}

		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}

	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0, true);
	outView.setUint32(4, b0, true);
	outView.setUint32(8, c0, true);
	outView.setUint32(12, d0, true);
	return out;
}

const textEncoder = new TextEncoder();

/** MD5 dari sebuah teks, dalam 32 huruf heksadesimal huruf kecil. */
export function md5Hex(text: string): string {
	return bytesToHex(md5Bytes(textEncoder.encode(text)));
}

// ---------------------------------------------------------------------------
// Hash password
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
	return bytesToHex(new Uint8Array(digest));
}

/**
 * Ubah password mentah jadi nilai yang boleh disimpan di
 * `user.password_hash`. Dipanggil dari sisi Worker — frontend TIDAK pernah
 * perlu mengirim hash.
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES)));
	return `${PASSWORD_HASH_TAG}$${salt}$${await sha256Hex(`${salt}:${password}`)}`;
}

/**
 * Cocokkan password mentah dengan isi kolom `password_hash`.
 *
 * Menerima juga hash MD5 polos 32 huruf (format lama/bekas alat lain) supaya
 * baris hasil migrasi lama tidak langsung terkunci. Dukungan itu bisa dihapus
 * begitu semua baris sudah memakai format `sha256-v1$…`.
 */
export async function verifyPassword(raw: string, stored: string | null): Promise<boolean> {
	if (!stored) return false;

	if (stored.startsWith(`${PASSWORD_HASH_TAG}$`)) {
		const rest = stored.slice(PASSWORD_HASH_TAG.length + 1);
		const sep = rest.indexOf("$");
		if (sep < 0) return false;
		const salt = rest.slice(0, sep);
		const expected = rest.slice(sep + 1);
		if (!/^[0-9a-f]{8,64}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) return false;
		return constantTimeEqual(await sha256Hex(`${salt}:${raw}`), expected);
	}

	// Cadangan: MD5 polos (32 huruf). Sengaja ditaruh paling akhir.
	if (looksLikeMd5(stored)) {
		return constantTimeEqual(md5Hex(raw), stored.toLowerCase());
	}

	return false;
}

/** true kalau kolom `password_hash` masih berisi MD5 polos (format lama). */
export function looksLikeMd5(stored: string | null): boolean {
	return typeof stored === "string" && /^[0-9a-f]{32}$/i.test(stored);
}

/**
 * Hash palsu untuk "membakar waktu" saat email tidak ditemukan di database.
 *
 * Tanpa ini, login ke email yang tidak ada membalas lebih cepat daripada login
 * ke email yang ada (yang harus menghitung SHA-256) — selisih waktunya bisa
 * dipakai menebak email siapa yang terdaftar. Rute login memakai konstanta ini
 * untuk melakukan perhitungan yang sama walau user-nya tidak ada.
 */
export const DUMMY_PASSWORD_HASH =
	"sha256-v1$00000000000000000000000000000000$a0df811e79069d7cb898d02e7336c1880b93579dabb9aaa84c199917005ae298";

/** Samakan waktu respons untuk email yang tidak terdaftar. */
export async function burnPasswordTime(raw: string): Promise<void> {
	await verifyPassword(raw, DUMMY_PASSWORD_HASH);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Rapikan email jadi bentuk pembanding yang konsisten.
 *
 * Kolom `email` di DB punya UNIQUE, dan UNIQUE di Postgres peka huruf besar
 * kecil: "Budi@X.com" dan "budi@x.com" dianggap dua akun berbeda. Karena
 * frontend bisa mengirim huruf apa saja, bentuknya diseragamkan lebih dulu;
 * query-nya juga memakai `lower(email)` supaya baris lama tetap kebaca.
 */
export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Pemeriksaan bentuk email yang sederhana tapi tidak terlalu longgar. */
export function isValidEmail(email: string): boolean {
	if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return false;
	if (email.length > MAX_EMAIL_LENGTH) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Token akses
// ---------------------------------------------------------------------------

const TOKEN_TAG = "v1";

/** Bentuk sidik jari di dalam token: MD5 heksadesimal penuh (32 huruf). */
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

/**
 * Ubah `password_hash` jadi sidik jari.
 *
 * Dua tempat memakainya, dan keduanya harus menghasilkan nilai yang SAMA
 * PERSIS: token yang dikirim ke client, dan catatan sesi di kolom
 * `machine_info` (lib/session.ts). Kalau nilainya beda, token yang sah akan
 * ikut ditolak.
 *
 * MD5 di sini tidak menyembunyikan password — kolom `password_hash` sudah
 * berisi SHA-256 + salt. Gunanya cuma jadi penanda "kredensial ini masih yang
 * sama": ganti password = sidik jarinya berubah = semua token lama mati.
 */
export function credentialFingerprint(passwordHash: string | null): string {
	return md5Hex(passwordHash ?? "");
}

function signToken(userId: string, exp: number, secret: string): string {
	return md5Hex(`${userId}.${exp}.${secret}`);
}

/**
 * Terbitkan token akses.
 *
 * `ttlS` = umur token dalam detik. Hasilnya:
 *   v1.<user_id>.<exp detik UNIX>.<tanda tangan>.<sidik jari kredensial>
 *
 * `nowS` (opsional) = "sekarang" dalam detik UNIX. Dipakai kalau pemanggil
 * ingin `exp` dihitung dari waktu DATABASE, bukan jam Worker — lihat catatan
 * waktu di lib/auth-time.ts. Kalau tidak diisi, jam Worker yang dipakai.
 */
export function issueAccessToken(
	userId: string,
	passwordHash: string | null,
	secret: string,
	ttlS: number,
	nowS?: number,
): string {
	const base = Number.isFinite(nowS) ? (nowS as number) : Math.floor(Date.now() / 1000);
	const exp = base + ttlS;
	const signature = signToken(userId, exp, secret);
	const fingerprint = credentialFingerprint(passwordHash);
	return `${TOKEN_TAG}.${userId}.${exp}.${signature}.${fingerprint}`;
}

/** Sidik jari token: nilai inilah yang disimpan aplikasi desktop (bukan tokennya). */
export function tokenHash(token: string): string {
	return md5Hex(token);
}

export interface AccessTokenInfo {
	userId: string;
	/** Waktu kadaluarsa (detik UNIX). */
	exp: number;
	/** Umur token dari sekarang (detik). Negatif = sudah lewat. */
	remainingS: number;
	/** Sidik jari kredensial yang ikut ditandatangani di dalam token. */
	fingerprint: string;
	/** Sisa masa berlaku token (detik) — hanya kalau diminta. */
	ttlS?: number;
}

export type AccessTokenResult =
	| { ok: true; info: AccessTokenInfo }
	| { ok: false; reason: "bocor" | "format" | "expired" | "signature" };

/**
 * Periksa token: bentuk, tanda tangan, dan masa berlaku.
 *
 * `options.passwordHash` — kalau diisi, sidik jari di dalam token juga
 * dicocokkan (ganti password = token lama mati).
 */
export function readAccessToken(
	token: string | null | undefined,
	secret: string,
	options: { passwordHash?: string | null; nowMs?: number; withTtl?: boolean } = {},
): AccessTokenResult {
	if (!token) return { ok: false, reason: "format" };
	if (token.length > 200) return { ok: false, reason: "bocor" };

	const parts = token.split(".");
	if (parts.length !== 5) return { ok: false, reason: "format" };
	const [tag, userId, expText, signature, fingerprint] = parts;
	if (tag !== TOKEN_TAG) return { ok: false, reason: "format" };
	if (!/^[0-9]{1,20}$/.test(userId)) return { ok: false, reason: "format" };
	if (!/^[0-9]{1,12}$/.test(expText)) return { ok: false, reason: "format" };
	if (!/^[0-9a-f]{32}$/.test(signature)) return { ok: false, reason: "format" };
	if (!FINGERPRINT_RE.test(fingerprint)) return { ok: false, reason: "format" };

	const exp = Number(expText);
	if (!constantTimeEqual(signToken(userId, exp, secret), signature)) {
		return { ok: false, reason: "signature" };
	}

	const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
	const remainingS = exp - nowS;
	if (remainingS <= 0) return { ok: false, reason: "expired" };

	if (options.passwordHash !== undefined && options.passwordHash !== null) {
		if (!constantTimeEqual(credentialFingerprint(options.passwordHash), fingerprint)) {
			return { ok: false, reason: "signature" };
		}
	}

	const info: AccessTokenInfo = { userId, exp, remainingS, fingerprint };
	if (options.withTtl) info.ttlS = remainingS;
	return { ok: true, info };
}

/** Pesan siap tampil untuk setiap alasan penolakan token. */
export const ACCESS_TOKEN_ERRORS: Record<string, string> = {
	bocor: "Token akses tidak sah.",
	format: "Header X-Access-Token tidak ada atau isinya bukan token yang sah.",
	expired: "Token akses sudah kadaluarsa. Silakan login ulang.",
	signature: "Token akses tidak sah atau sudah tidak berlaku. Silakan login ulang.",
};

// ---------------------------------------------------------------------------
// Kode OTP
// ---------------------------------------------------------------------------

/** Kode OTP angka dengan jumlah digit tetap (nol di depan tidak hilang). */
export function generateOtpCode(digits: number): string {
	const max = 10 ** digits;
	const limit = Math.floor(0x1_0000_0000 / max) * max; // buang sampel di luar rentang
	const buf = new Uint32Array(1);
	let value: number;
	do {
		crypto.getRandomValues(buf);
		value = buf[0];
	} while (value >= limit);
	return String(value % max).padStart(digits, "0");
}

/**
 * Kode OTP yang aman disimpan di kolom `otp_code` (`int4`).
 *
 * Kolom itu menyimpan ANGKA, jadi kode berawalan nol ("0123") tersimpan sebagai
 * 123 — dan kalau user mengetik "123", angkanya cocok. Artinya rentang tebakan
 * jadi lebih lebar dari yang seharusnya. Karena itu digit pertamanya dijaga
 * tidak nol, supaya kode selalu benar-benar sepanjang `digits`.
 */
export function generateStoredOtpCode(digits: number): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const code = generateOtpCode(digits);
		if (code[0] !== "0") return code;
	}
	return generateOtpCode(digits);
}

/**
 * Verifikasi kode OTP ada di routes/auth-verify.ts.
 *
 * Kode MENTAH tidak pernah disimpan: yang masuk ke `otp.otp_code` adalah
 * angkanya sendiri (`int4`), sesuai bentuk kolom yang sudah ada, dan kode itu
 * langsung ditutup (`is_used = true`) begitu terpakai, kadaluarsa, atau
 * percobaan salahnya kelewat batas.
 */
