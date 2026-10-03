/**
 * Tes unit perkakas auth — semuanya fungsi murni: tanpa Worker, tanpa HTTP,
 * tanpa database.
 *
 * Yang diuji di sini adalah janji-janji yang mudah rusak tanpa terlihat:
 * hash password bisa dibaca ulang, token yang diubah satu huruf ditolak,
 * dan catatan sesi di `machine_info` tidak menghapus data FE.
 */

import { describe, it, expect } from "vitest";
import {
	bytesToHex,
	credentialFingerprint,
	generateOtpCode,
	generateStoredOtpCode,
	hashPassword,
	hexToBytes,
	isValidEmail,
	looksLikeMd5,
	md5Hex,
	normalizeEmail,
	readAccessToken,
	issueAccessToken,
	tokenHash,
	verifyPassword,
} from "../src/lib/auth";
import {
	buildMachineParts,
	deviceMatches,
	hasDevice,
	parseRecoveryDevice,
	perangkatSah,
	readMachineParts,
	sessionAcceptsFingerprint,
	sessionMatches,
	withDevice,
	withMachineInfo,
	withSession,
	withoutSession,
	type DeviceRecord,
	type SessionRecord,
} from "../src/lib/session";
import { clampTtl, ttlDariRequest } from "../src/lib/auth-session";
import { looksLikeTokenHash, preflightSession, sessionFailStatus } from "../src/lib/session-guard";
import {
	deviceIdFrom,
	deviceIdProblem,
	deviceInputProblem,
	deviceNameFrom,
} from "../src/lib/auth-device";

const SECRET = "rahasia-uji";

describe("md5Hex() — vektor uji resmi RFC 1321", () => {
	// Kalau implementasi MD5 sendiri salah, token tidak akan pernah cocok
	// antar-versi Worker — jadi ini pemeriksaan yang wajib.
	it("cocok dengan vektor uji yang terdokumentasi", () => {
		expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
		expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
		expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
		expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe(
			"57edf4a22be3c955ac49da2e2107b67a",
		);
	});

	it("input non-ASCII (UTF-8) juga benar", () => {
		// "é" = 0xC3 0xA9 dalam UTF-8 (bukan Latin-1 0xE9). Kalau encodingnya
		// keliru, sidik jari OTP/token akan beda antar-runtime.
		expect(md5Hex("é")).toBe("66ddcd97cfdeabb2f6fb8a999b4bc76f");
	});
});

describe("hashPassword() / verifyPassword()", () => {
	it("hash bisa diverifikasi ulang dengan password yang sama", async () => {
		const stored = await hashPassword("rahasia123");
		expect(await verifyPassword("rahasia123", stored)).toBe(true);
	});

	it("password salah ditolak", async () => {
		const stored = await hashPassword("rahasia123");
		expect(await verifyPassword("rahasia124", stored)).toBe(false);
		expect(await verifyPassword("", stored)).toBe(false);
		expect(await verifyPassword("RAHASIA123", stored)).toBe(false);
	});

	it("dua user berpassword SAMA menghasilkan hash BERBEDA (ada salt)", async () => {
		// Ini alasan utama MD5 polos tidak dipakai untuk password.
		const a = await hashPassword("password-sama");
		const b = await hashPassword("password-sama");
		expect(a).not.toBe(b);
		expect(await verifyPassword("password-sama", a)).toBe(true);
		expect(await verifyPassword("password-sama", b)).toBe(true);
	});

	it("hash bermerek `sha256-v1$` dan tidak memuat password mentah", async () => {
		const stored = await hashPassword("jangan-terlihat");
		expect(stored.startsWith("sha256-v1$")).toBe(true);
		expect(stored).not.toContain("jangan-terlihat");
	});

	it("password_hash kosong/null tidak pernah dianggap cocok", async () => {
		expect(await verifyPassword("apa pun", null)).toBe(false);
		expect(await verifyPassword("apa pun", "")).toBe(false);
		expect(await verifyPassword("", null)).toBe(false);
	});

	it("menerima hash MD5 polos 32 huruf sebagai cadangan (data lama)", async () => {
		// Data user lama (kalau ada) memakai MD5 polos; mereka harus tetap
		// bisa masuk, dan hash-nya naik kelas sendiri saat password diganti.
		const md5 = md5Hex("rahasia123");
		expect(await verifyPassword("rahasia123", md5)).toBe(true);
		expect(await verifyPassword("rahasia124", md5)).toBe(false);
	});

	it("bentuk hash yang tidak dikenal ditolak, bukan dilewatkan", async () => {
		expect(await verifyPassword("x", "bukan-hash-apa-pun")).toBe(false);
		expect(await verifyPassword("x", "sha256-v1$rusak")).toBe(false);
		expect(await verifyPassword("x", "$sal✔t$00")).toBe(false);
	});
});

describe("looksLikeMd5()", () => {
	it("hanya menerima 32 huruf heksadesimal", () => {
		expect(looksLikeMd5(md5Hex("x"))).toBe(true);
		expect(looksLikeMd5("A".repeat(32))).toBe(true);
		expect(looksLikeMd5("a".repeat(31))).toBe(false);
		expect(looksLikeMd5("z".repeat(32))).toBe(false);
		expect(looksLikeMd5("")).toBe(false);
	});
});

describe("normalizeEmail() / isValidEmail()", () => {
	it("menurunkan huruf dan memangkas", () => {
		expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
	});

	it("menerima bentuk yang wajar", () => {
		for (const email of ["a@b.co", "nama.belakang+tag@sub.domain.id"]) {
			expect({ email, ok: isValidEmail(email) }).toEqual({ email, ok: true });
		}
	});

	it("menolak bentuk yang ngawur", () => {
		for (const email of ["bukan-email", "a@b", "@b.com", "a@.com", "a b@c.com", ""]) {
			expect({ email, ok: isValidEmail(email) }).toEqual({ email, ok: false });
		}
	});
});

describe("token akses", () => {
	const userId = "12";
	const hash = "sha256-v1$" + "0".repeat(32) + "$" + "f".repeat(64);

	it("token terbitan bisa dibaca ulang", () => {
		const token = issueAccessToken(userId, hash, SECRET, 3600, 1_700_000_000);
		const result = readAccessToken(token, SECRET, { nowMs: 1_700_000_000_000 });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.info.userId).toBe(userId);
			expect(result.info.exp).toBe(1_700_003_600);
			expect(result.info.fingerprint).toBe(credentialFingerprint(hash));
		}
	});

	it("bentuknya persis v1.<id>.<exp>.<tanda tangan>.<sidik jari>", () => {
		const token = issueAccessToken(userId, hash, SECRET, 60, 1_700_000_000);
		const parts = token.split(".");
		expect(parts).toHaveLength(5);
		expect(parts[0]).toBe("v1");
		expect(parts[1]).toBe(userId);
		expect(parts[2]).toBe("1700000060");
		// Tanda tangan = md5(user_id + "." + exp + "." + AUTH_SECRET)
		expect(parts[3]).toBe(md5Hex(`${userId}.1700000060.${SECRET}`));
		expect(parts[4]).toBe(credentialFingerprint(hash));
	});

	it("secret lain -> ditolak (tanda tangan tidak cocok)", () => {
		const token = issueAccessToken(userId, hash, SECRET, 3600, 1_700_000_000);
		const result = readAccessToken(token, "secret-yang-lain", { nowMs: 1_700_000_000_000 });
		expect(result).toEqual({ ok: false, reason: "signature" });
	});

	it("mengubah exp di sisi client merusak tanda tangan", () => {
		// Ini inti keamanannya: masa berlaku tidak bisa diperpanjang sendiri.
		const token = issueAccessToken(userId, hash, SECRET, 60, 1_700_000_000);
		const parts = token.split(".");
		parts[2] = String(Number(parts[2]) + 999_999);
		const result = readAccessToken(parts.join("."), SECRET, { nowMs: 1_700_000_000_000 });
		expect(result).toEqual({ ok: false, reason: "signature" });
	});

	it("mengubah user_id (mengaku user lain) merusak tanda tangan", () => {
		const token = issueAccessToken(userId, hash, SECRET, 3600, 1_700_000_000);
		const parts = token.split(".");
		parts[1] = "13";
		expect(readAccessToken(parts.join("."), SECRET, { nowMs: 1_700_000_000_000 })).toEqual({
			ok: false,
			reason: "signature",
		});
	});

	it("token kadaluarsa ditolak dengan alasan `expired`", () => {
		const token = issueAccessToken(userId, hash, SECRET, 60, 1_700_000_000);
		expect(readAccessToken(token, SECRET, { nowMs: 1_700_000_061_000 })).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it("ganti password -> token lama ditolak walau tanda tangannya sah", () => {
		const token = issueAccessToken(userId, hash, SECRET, 3600, 1_700_000_000);
		const hashBaru = "sha256-v1$" + "1".repeat(32) + "$" + "e".repeat(64);
		expect(readAccessToken(token, SECRET, { passwordHash: hashBaru, nowMs: 1_700_000_000_000 })).toEqual({
			ok: false,
			reason: "signature",
		});
		// Password yang sama tetap diterima.
		expect(readAccessToken(token, SECRET, { passwordHash: hash, nowMs: 1_700_000_000_000 }).ok).toBe(true);
	});

	it("bentuk rusak ditolak tanpa melempar error", () => {
		const bad = [
			"",
			"ngawur",
			"v1.12.1700000060.abcdef",
			"v2.12.1700000060." + "a".repeat(32) + "." + "b".repeat(32),
			"v1.abc.1700000060." + "a".repeat(32) + "." + "b".repeat(32),
			"v1.12.bukan-angka." + "a".repeat(32) + "." + "b".repeat(32),
			"v1.12.1700000060." + "a".repeat(32),
			"x".repeat(300),
		];
		for (const token of bad) {
			const result = readAccessToken(token, SECRET, { nowMs: 1_700_000_000_000 });
			expect({ token: token.slice(0, 20), ok: result.ok }).toEqual({ token: token.slice(0, 20), ok: false });
		}
	});

	it("null/undefined/string panjang ditolak tanpa melempar", () => {
		expect(readAccessToken(null, SECRET).ok).toBe(false);
		expect(readAccessToken(undefined, SECRET).ok).toBe(false);
		expect(readAccessToken("x".repeat(201), SECRET)).toEqual({ ok: false, reason: "bocor" });
	});

	it("tokenHash adalah md5 dari tokennya", () => {
		const token = issueAccessToken(userId, hash, SECRET, 3600, 1_700_000_000);
		expect(tokenHash(token)).toBe(md5Hex(token));
		expect(looksLikeTokenHash(tokenHash(token))).toBe(true);
		expect(looksLikeTokenHash(token)).toBe(false);
	});
});

describe("bytesToHex() / hexToBytes()", () => {
	it("bolak-balik menghasilkan nilai yang sama", () => {
		const bytes = new Uint8Array([0, 15, 16, 255, 128]);
		expect(bytesToHex(bytes)).toBe("000f10ff80");
		expect(Array.from(hexToBytes("000f10ff80") ?? [])).toEqual([0, 15, 16, 255, 128]);
	});

	it("hex tidak sah mengembalikan null, bukan hasil sampah", () => {
		expect(hexToBytes("abc")).toBeNull();
		expect(hexToBytes("zz")).toBeNull();
	});
});

describe("kode OTP", () => {
	it("selalu tepat sepanjang digit yang diminta", () => {
		for (const digits of [4, 5, 6]) {
			for (let i = 0; i < 200; i++) {
				expect(generateOtpCode(digits)).toHaveLength(digits);
				expect(generateStoredOtpCode(digits)).toHaveLength(digits);
			}
		}
	});

	it("kode yang DISIMPAN tidak pernah berawalan nol", () => {
		// Kolom `otp_code` bertipe int4: kode berawalan nol akan tersimpan
		// sebagai angka lebih pendek, jadi rentang tebakannya melebar.
		for (let i = 0; i < 500; i++) {
			expect(generateStoredOtpCode(4)[0]).not.toBe("0");
			expect(generateStoredOtpCode(6)[0]).not.toBe("0");
		}
	});

	it("kode hanya berisi angka", () => {
		for (let i = 0; i < 100; i++) {
			expect(generateOtpCode(4)).toMatch(/^\d{4}$/);
		}
	});

	it("tidak selalu mengembalikan kode yang sama", () => {
		const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode(4)));
		expect(codes.size).toBeGreaterThan(10);
	});
});

describe("clampTtl() — umur token yang diminta client", () => {
	it("nilai wajar dipakai apa adanya", () => {
		expect(clampTtl(3600)).toBe(3600);
	});

	it("nilai ekstrem dijepit, bukan ditolak", () => {
		expect(clampTtl(1)).toBe(60); // ACCESS_TOKEN_MIN_TTL_S
		expect(clampTtl(999_999_999)).toBe(7 * 86400); // ACCESS_TOKEN_MAX_TTL_S
		expect(clampTtl(-5)).toBe(60);
	});

	it("nilai ngawur memakai bawaan 7 hari", () => {
		expect(clampTtl(Number.NaN)).toBe(7 * 86400);
		expect(clampTtl(Number.POSITIVE_INFINITY)).toBe(7 * 86400);
	});

	it("pecahan dipangkas jadi bulat", () => {
		expect(clampTtl(3600.9)).toBe(3600);
	});
});

describe("ttlDariRequest() — umur token dari header/query", () => {
	/** Request contoh; tanpa database, tanpa Worker. */
	const req = (headers: Record<string, string> = {}) =>
		new Request("https://example.com/api/auth/login", { headers });

	it("TANPA header dan TANPA query -> bawaan 7 hari (regresi bug sesi-60-detik)", () => {
		// Dulu: Number(header ?? "") = Number("") = 0 -> dijepit ke 60 detik.
		// Aplikasi desktop tidak pernah mengirim header ini, jadi SEMUA sesi
		// terbit 60 detik dan aplikasi memaksa login ulang tiap dibuka.
		expect(ttlDariRequest(req())).toBe(7 * 86400);
	});

	it("URL tanpa ?ttl_s= -> bawaan 7 hari", () => {
		expect(ttlDariRequest(req(), new URL("https://example.com/api/auth/login"))).toBe(7 * 86400);
	});

	it("header berisi angka -> dipakai (dijepit clampTtl)", () => {
		expect(ttlDariRequest(req({ "x-token-ttl-seconds": "3600" }))).toBe(3600);
		expect(ttlDariRequest(req({ "x-token-ttl-seconds": "0" }))).toBe(60);
	});

	it("header kosong/spasi -> dianggap tidak diminta, bawaan 7 hari", () => {
		expect(ttlDariRequest(req({ "x-token-ttl-seconds": "" }))).toBe(7 * 86400);
		expect(ttlDariRequest(req({ "x-token-ttl-seconds": "   " }))).toBe(7 * 86400);
	});

	it("header bukan angka -> dianggap tidak diminta, bawaan 7 hari", () => {
		expect(ttlDariRequest(req({ "x-token-ttl-seconds": "minggu" }))).toBe(7 * 86400);
	});

	it("query ?ttl_s= dipakai kalau header tidak mengirim angka", () => {
		expect(ttlDariRequest(req(), new URL("https://example.com/api/auth/login?ttl_s=7200"))).toBe(7200);
		expect(
			ttlDariRequest(req({ "x-token-ttl-seconds": "   " }), new URL("https://example.com/?ttl_s=7200")),
		).toBe(7200);
	});

	it("query ngawur -> bawaan 7 hari", () => {
		expect(ttlDariRequest(req(), new URL("https://example.com/?ttl_s=abc"))).toBe(7 * 86400);
	});
});

describe("catatan sesi di dalam machine_info", () => {
	const sesi: SessionRecord = {
		v: 1,
		exp: 1_700_003_600,
		iat: 1_700_000_000,
		fp: "a".repeat(32),
		th: "b".repeat(32),
	};

	it("teks kosong/null menghasilkan catatan kosong", () => {
		for (const raw of [null, "", "   "]) {
			const parts = readMachineParts(raw);
			expect({ raw, sesi: parts.sesi, mesin: parts.mesin }).toEqual({ raw, sesi: null, mesin: null });
		}
	});

	it("catatan sesi bertahan setelah bolak-balik teks", () => {
		const text = withSession(null, sesi);
		expect(readMachineParts(text).sesi).toEqual(sesi);
	});

	it("informasi komputer FE dan catatan sesi HIDUP BERDAMPINGAN", () => {
		// Ini inti desainnya: satu kolom dipakai dua pemilik. Kalau salah satu
		// penulisan menimpa yang lain, alur login atau info mesin akan hilang.
		const denganMesin = withMachineInfo(null, { os: "Windows 11", cpu: "i7" });
		const denganSesi = withSession(denganMesin, sesi);

		const parts = readMachineParts(denganSesi);
		expect(parts.sesi).toEqual(sesi);
		expect(parts.mesin).toEqual({ os: "Windows 11", cpu: "i7" });

		// Menulis info mesin LAGI tidak boleh menghapus catatan sesinya.
		const mesinBaru = withMachineInfo(denganSesi, { os: "Linux" });
		const parts2 = readMachineParts(mesinBaru);
		expect(parts2.sesi).toEqual(sesi);
		expect(parts2.mesin).toEqual({ os: "Linux" });
	});

	it("logout membuang catatan sesi TAPI menyisakan info mesin", () => {
		const penuh = withMachineInfo(withSession(null, sesi), { os: "Windows 11" });
		const habis = withoutSession(penuh);
		const parts = readMachineParts(habis);
		expect(parts.sesi).toBeNull();
		expect(parts.mesin).toEqual({ os: "Windows 11" });
	});

	it("teks bebas lama diperlakukan sebagai isi `mesin`, tidak dibuang", () => {
		// Data lama (sebelum kode ini) bisa berisi teks apa saja. User tidak
		// boleh kehilangan datanya hanya karena bentuknya berubah.
		const parts = readMachineParts("Windows 10 - Ryzen 5");
		expect(parts.sesi).toBeNull();
		expect(parts.mesin).toBe("Windows 10 - Ryzen 5");
	});

	it("JSON rusak tidak membuat login gagal", () => {
		const parts = readMachineParts("{rusak");
		expect(parts.sesi).toBeNull();
		expect(parts.mesin).toBe("{rusak");
	});

	it("kunci yang tidak dikenal dipertahankan (tidak hilang saat ditulis ulang)", () => {
		const raw = JSON.stringify({ catatan_lain: "penting", mesin: { os: "X" } });
		const parts = readMachineParts(raw);
		expect(parts.lain).toEqual({ catatan_lain: "penting" });
		const ulang = buildMachineParts({ ...parts, sesi });
		const parseUlang = JSON.parse(ulang) as Record<string, unknown>;
		expect(parseUlang.catatan_lain).toBe("penting");
		expect(parseUlang.sesi).toEqual(sesi);
	});

	it("catatan sesi yang bentuknya rusak diabaikan (bukan bikin error)", () => {
		for (const rusak of [
			'{"sesi": "bukan objek"}',
			'{"sesi": {"exp": "bukan angka"}}',
			'{"sesi": {"exp": 1, "iat": 1, "fp": "pendek", "th": "pendek"}}',
			'{"sesi": {"exp": 0, "iat": 0, "fp": "' + "a".repeat(32) + '", "th": "' + "b".repeat(32) + '"}}',
			'{"sesi": null}',
		]) {
			expect(readMachineParts(rusak).sesi).toBeNull();
		}
	});

	it("sesi cocok hanya kalau exp DAN sidik jari kredensialnya sama", () => {
		expect(sessionMatches(sesi, { exp: sesi.exp, fingerprint: sesi.fp })).toBe(true);
		expect(sessionMatches(sesi, { exp: sesi.exp + 1, fingerprint: sesi.fp })).toBe(false);
		expect(sessionMatches(sesi, { exp: sesi.exp, fingerprint: "c".repeat(32) })).toBe(false);
		expect(sessionMatches(null, { exp: sesi.exp, fingerprint: sesi.fp })).toBe(false);
	});

	it("jalur sidik jari desktop: token hash + kredensial + masa berlaku", () => {
		const nowS = sesi.exp - 10;
		expect(sessionAcceptsFingerprint(sesi, sesi.th, sesi.fp, nowS)).toBe(true);
		// sidik jari token salah
		expect(sessionAcceptsFingerprint(sesi, "c".repeat(32), sesi.fp, nowS)).toBe(false);
		// password sudah diganti
		expect(sessionAcceptsFingerprint(sesi, sesi.th, "d".repeat(32), nowS)).toBe(false);
		// sudah kadaluarsa
		expect(sessionAcceptsFingerprint(sesi, sesi.th, sesi.fp, sesi.exp)).toBe(false);
		// belum pernah login
		expect(sessionAcceptsFingerprint(null, sesi.th, sesi.fp, nowS)).toBe(false);
	});
});

describe("preflightSession() — penolakan SEBELUM database dibuka", () => {
	/** Env tiruan; hanya AUTH_SECRET yang dipakai pemeriksaan ini. */
	const env = { AUTH_SECRET: SECRET } as unknown as Env;

	function req(headers: Record<string, string>): Request {
		return new Request("https://example.com/api/auth/me", { headers });
	}

	it("tanpa header token -> 401", () => {
		const result = preflightSession(req({}), env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(401);
	});

	it("token utuh yang sah -> lolos, user_id diambil dari token", () => {
		const token = issueAccessToken("7", null, SECRET, 3600);
		const result = preflightSession(req({ "x-access-token": token }), env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mode).toBe("token");
			expect(result.userId).toBe("7");
		}
	});

	it("token utuh yang tanda tangannya salah -> 401 (bukan 500)", () => {
		const token = issueAccessToken("7", null, SECRET, 3600);
		const parts = token.split(".");
		// Rusak TANDA TANGANNYA (bagian ke-4) — itu yang diperiksa preflight.
		parts[3] = "f".repeat(32);
		const result = preflightSession(req({ "x-access-token": parts.join(".") }), env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(401);
	});

	it("mengubah sidik jari saja tetap lolos preflight (sidik jari tidak ditandatangani)", () => {
		// Catatan penting soal desain: tanda tangan hanya menahan user_id + exp.
		// Sidik jari kredensial BARU diperiksa `requireSession` dengan
		// membandingkannya terhadap `password_hash` di database — jadi
		// mengubahnya di sisi client tidak membuka apa pun.
		const token = issueAccessToken("7", null, SECRET, 3600);
		const parts = token.split(".");
		parts[4] = "e".repeat(32);
		expect(preflightSession(req({ "x-access-token": parts.join(".") }), env).ok).toBe(true);
	});

	it("token utuh milik secret lain -> 401", () => {
		const token = issueAccessToken("7", null, "secret-lain", 3600);
		expect(preflightSession(req({ "x-access-token": token }), env).ok).toBe(false);
	});

	it("token kadaluarsa -> 401 dengan kode SESI_HABIS", () => {
		const token = issueAccessToken("7", null, SECRET, 60, 1_700_000_000);
		const result = preflightSession(req({ "x-access-token": token }), env);
		// Catatan: preflight memakai jam sekarang, jadi token 2023 sudah lewat.
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("SESI_HABIS");
	});

	it("sidik jari 32 huruf heksadesimal TANPA X-User-Id -> 400, bukan 401", () => {
		const result = preflightSession(req({ "x-access-token": "c".repeat(32) }), env);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(400);
			expect(result.code).toBe("USER_ID_TIDAK_ADA");
		}
	});

	it("sidik jari + user_id yang sah -> lolos", () => {
		const result = preflightSession(
			req({ "x-access-token": "c".repeat(32), "x-user-id": "12" }),
			env,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mode).toBe("sidik-jari");
			expect(result.userId).toBe("12");
		}
	});

	it("user_id bukan angka ditolak, walau bentuknya mirip", () => {
		for (const bad of ["abc", "1 2", "1.5", "-1", ""]) {
			const result = preflightSession(
				req({ "x-access-token": "c".repeat(32), "x-user-id": bad }),
				env,
			);
			expect({ bad, ok: result.ok }).toEqual({ bad, ok: false });
		}
	});

	it("nilai X-Access-Token yang bukan token utuh maupun sidik jari -> 401", () => {
		for (const bad of ["ngawur", "x".repeat(31), "z".repeat(32), "v2." + "a".repeat(40)]) {
			const result = preflightSession(
				req({ "x-access-token": bad, "x-user-id": "1" }),
				env,
			);
			expect({ bad: bad.slice(0, 12), ok: result.ok }).toEqual({ bad: bad.slice(0, 12), ok: false });
		}
	});
});

// ===========================================================================
// Aturan perangkat (W12) — dua catatan, satu yang menang
// ===========================================================================

const PC_A: DeviceRecord = {
	device_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	device_name: "PC-A",
	terdaftar_pada: 1_700_000_000,
	terakhir_masuk: 1_700_000_000,
};

const PC_B: DeviceRecord = {
	device_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	device_name: "PC-B",
	terdaftar_pada: 1_700_000_500,
	terakhir_masuk: 1_700_000_500,
};

describe("perangkatSah() — catatan pemulihan menang atas catatan login", () => {
	it("keduanya kosong -> tidak ada perangkat", () => {
		const hasil = perangkatSah(null, null);
		expect(hasil.perangkat).toBe(null);
		expect(hasil.sumber).toBe("kosong");
	});

	it("hanya catatan login -> catatan login yang berlaku", () => {
		const hasil = perangkatSah(PC_A, null);
		expect(hasil.perangkat?.device_id).toBe(PC_A.device_id);
		expect(hasil.sumber).toBe("login");
	});

	it("hanya catatan pemulihan -> catatan pemulihan yang berlaku", () => {
		const hasil = perangkatSah(null, PC_B);
		expect(hasil.perangkat?.device_id).toBe(PC_B.device_id);
		expect(hasil.sumber).toBe("pemulihan");
	});

	it("KEDUANYA terisi dan BEDA -> catatan pemulihan menang", () => {
		// Inilah keadaan setelah pengguna memulihkan akun: catatan login masih
		// menyebut komputer lama, catatan pemulihan menyebut komputer baru.
		// Kalau aturan ini terbalik, pengguna yang baru berhasil memulihkan
		// akan langsung tertolak.
		const hasil = perangkatSah(PC_A, PC_B);
		expect(hasil.perangkat?.device_id).toBe(PC_B.device_id);
		expect(hasil.sumber).toBe("pemulihan");
	});

	it("catatan pemulihan kosong isinya dianggap tidak ada", () => {
		const kosong: DeviceRecord = { ...PC_B, device_id: "" };
		expect(perangkatSah(PC_A, kosong).sumber).toBe("login");
	});
});

describe("deviceMatches() / hasDevice()", () => {
	it("cocok hanya kalau device_id persis sama (spasi dipangkas)", () => {
		expect(deviceMatches(PC_A, PC_A.device_id)).toBe(true);
		expect(deviceMatches(PC_A, `  ${PC_A.device_id}  `)).toBe(true);
		expect(deviceMatches(PC_A, PC_B.device_id)).toBe(false);
		expect(deviceMatches(null, PC_A.device_id)).toBe(false);
	});

	it("hasDevice() menolak catatan null dan device_id kosong", () => {
		expect(hasDevice(null)).toBe(false);
		expect(hasDevice({ ...PC_A, device_id: "" })).toBe(false);
		expect(hasDevice(PC_A)).toBe(true);
	});
});

describe("deviceIdProblem() — bentuk identitas komputer", () => {
	it("kosong ditolak dengan petunjuk header", () => {
		expect(deviceIdProblem("")).toContain("x-device-id");
	});

	it("terlalu pendek ditolak (kemungkinan bug aplikasi)", () => {
		for (const pendek of ["a", "abc", "1234567"]) {
			expect({ pendek, tolak: deviceIdProblem(pendek) !== null }).toEqual({ pendek, tolak: true });
		}
	});

	it("MachineGuid 32 huruf diterima", () => {
		expect(deviceIdProblem(PC_A.device_id)).toBe(null);
	});

	it("kepanjangan ditolak", () => {
		expect(deviceIdProblem("a".repeat(129))).not.toBe(null);
	});
});

describe("lihat perangkat dari body / header", () => {
	const req = (headers: Record<string, string>) => new Request("https://x/api", { headers });

	it("body menang atas header", () => {
		const r = req({ "x-device-id": PC_A.device_id });
		expect(deviceIdFrom(r, { device_id: PC_B.device_id })).toBe(PC_B.device_id);
	});

	it("header dipakai kalau body tidak punya device_id", () => {
		const r = req({ "x-device-id": PC_A.device_id });
		expect(deviceIdFrom(r, {})).toBe(PC_A.device_id);
		expect(deviceIdFrom(r)).toBe(PC_A.device_id);
	});

	it("tanpa keduanya -> string kosong (bukan error)", () => {
		expect(deviceIdFrom(req({}))).toBe("");
	});

	it("device_name boleh kosong dan dipangkas", () => {
		const r = req({ "x-device-name": "  PC-01  " });
		expect(deviceNameFrom(r)).toBe("PC-01");
		expect(deviceNameFrom(req({}))).toBe("");
	});

	it("deviceInputProblem memakai aturan yang sama dengan deviceIdProblem", () => {
		expect(deviceInputProblem({ device_id: "", device_name: "" })).not.toBe(null);
		expect(deviceInputProblem({ device_id: PC_A.device_id, device_name: "" })).toBe(null);
	});
});

describe("parseRecoveryDevice() — isi recovery_user.machine_info", () => {
	it("NULL / kosong -> null (kode belum pernah dipakai)", () => {
		expect(parseRecoveryDevice(null)).toBe(null);
		expect(parseRecoveryDevice("")).toBe(null);
		expect(parseRecoveryDevice("   ")).toBe(null);
	});

	it("JSON perangkat yang ditulis worker bisa dibaca ulang", () => {
		const hasil = parseRecoveryDevice(JSON.stringify(PC_A));
		expect(hasil?.device_id).toBe(PC_A.device_id);
		expect(hasil?.device_name).toBe("PC-A");
	});

	it("teks yang bukan JSON dianggap tidak ada perangkat, bukan error", () => {
		expect(parseRecoveryDevice("catatan bebas dari proses lain")).toBe(null);
		expect(parseRecoveryDevice("{rusak")).toBe(null);
		expect(parseRecoveryDevice('{"tanpa":"device_id"}')).toBe(null);
	});
});

describe("sessionFailStatus() — 401 vs 400", () => {
	it("permintaan yang bentuknya salah -> 400 (jangan tendang pengguna)", () => {
		// 401 membuat aplikasi desktop menghapus sesi dan menendang pengguna ke
		// layar masuk. Itu salah untuk bug aplikasi sendiri yang lupa mengirim
		// header — sesinya sebenarnya masih sehat.
		expect(sessionFailStatus("PERANGKAT_TIDAK_JELAS")).toBe(400);
		expect(sessionFailStatus("USER_ID_TIDAK_ADA")).toBe(400);
	});

	it("sesi yang memang tidak berlaku -> 401", () => {
		for (const kode of [
			"TOKEN_TIDAK_ADA",
			"TOKEN_TIDAK_SAH",
			"SESI_HABIS",
			"SESI_TIDAK_DIKENAL",
			"AKUN_TIDAK_ADA",
			"PERANGKAT_TIDAK_COCOK",
		] as const) {
			expect({ kode, status: sessionFailStatus(kode) }).toEqual({ kode, status: 401 });
		}
	});
});

describe("catatan perangkat di machine_info", () => {
	it("withDevice() menyimpan perangkat TANPA mengganggu sesi dan mesin", () => {
		const sesi: SessionRecord = { v: 1, exp: 1_700_100_000, iat: 1_700_000_000, fp: "a".repeat(32), th: "b".repeat(32) };
		const awal = buildMachineParts({ sesi, perangkat: null, mesin: { os: "Windows 11" }, lain: {} });
		const akhir = withDevice(awal, PC_A);

		const parts = readMachineParts(akhir);
		expect(parts.sesi?.exp).toBe(sesi.exp);
		expect(parts.perangkat?.device_id).toBe(PC_A.device_id);
		expect(parts.mesin).toEqual({ os: "Windows 11" });
	});

	it("logout membuang sesi TAPI perangkat TETAP terdaftar", () => {
		// Kalau perangkat ikut terhapus, siapa pun yang tahu password bisa
		// pindah komputer hanya dengan meminta pemiliknya logout.
		const sesi: SessionRecord = { v: 1, exp: 1_700_100_000, iat: 1_700_000_000, fp: "a".repeat(32), th: "b".repeat(32) };
		const awal = buildMachineParts({ sesi, perangkat: PC_A, mesin: null, lain: {} });
		const akhir = withoutSession(awal);

		const parts = readMachineParts(akhir);
		expect(parts.sesi).toBe(null);
		expect(parts.perangkat?.device_id).toBe(PC_A.device_id);
	});

	it("catatan perangkat rusak diabaikan, bagian lain tetap terbaca", () => {
		const rusak = JSON.stringify({
			sesi: { v: 1, exp: 1_700_100_000, iat: 1_700_000_000, fp: "a".repeat(32), th: "b".repeat(32) },
			perangkat: { device_id: "" },
			mesin: { os: "Windows 11" },
		});
		const parts = readMachineParts(rusak);
		expect(parts.perangkat).toBe(null);
		expect(parts.sesi).not.toBe(null);
		expect(parts.mesin).toEqual({ os: "Windows 11" });
	});
});
