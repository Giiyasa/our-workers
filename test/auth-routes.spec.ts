/**
 * Tes alur auth di lapisan HTTP: bentuk validasi, urutan penolakan, dan
 * penjagaan sesi.
 *
 * Seperti test/routes.spec.ts, tes ini TIDAK menyentuh database: `DIRECT_URL`
 * dikosongkan di vitest.config.mts. Jadi rute yang lolos validasi berhenti di
 * gerbang "DIRECT_URL belum di-set" (500) — dan respons itu justru buktinya.
 *
 * Yang sengaja diuji lebih dulu adalah JALUR PENOLAKAN, karena di situlah bug
 * auth biasanya bersembunyi: permintaan ngawur yang lolos validasi, atau token
 * yang diperiksa SETELAH database dibuka.
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "https://example.com";

/**
 * Identitas komputer contoh. Mulai PRD v0.4 rute login/verify memeriksa
 * `x-device-id`, jadi permintaan yang bermaksud LOLOS validasi awal wajib
 * menyertakannya — kalau tidak, yang teruji cuma validasi header.
 *
 * Bentuknya: 32 huruf heksadesimal, sama seperti MachineGuid Windows.
 */
const DEVICE = { "x-device-id": "b7a3f5c1d9e24680a1b2c3d4e5f60718", "x-device-name": "PC-TEST" };

/** Kirim POST JSON, kembalikan respons beserta body-nya. */
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	const res = await SELF.fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const parsed = (await res.json()) as Record<string, unknown>;
	return { res, body: parsed };
}

/** Kirim GET dengan header, kembalikan status + body. */
async function get(path: string, headers: Record<string, string> = {}) {
	const res = await SELF.fetch(`${BASE}${path}`, { headers });
	const parsed = (await res.json()) as Record<string, unknown>;
	return { res, body: parsed };
}

/** Bukti bahwa permintaan TIDAK membuka koneksi database. */
function stopsAtDbGate(body: Record<string, unknown>): boolean {
	return String(body.error ?? "").includes("DIRECT_URL");
}

describe("POST /api/auth/login — validasi sebelum database", () => {
	it("body kosong ditolak 400", async () => {
		const { res } = await post("/api/auth/login", "");
		expect(res.status).toBe(400);
	});

	it("bukan JSON ditolak 400", async () => {
		const { res } = await post("/api/auth/login", "{bukan json");
		expect(res.status).toBe(400);
	});

	it("email saja (tanpa password) ditolak 400", async () => {
		const { res, body } = await post("/api/auth/login", { email: "a@b.com" });
		expect(res.status).toBe(400);
		expect(String(body.error)).toContain("password");
	});

	it("password saja (tanpa email) ditolak 400", async () => {
		const { res } = await post("/api/auth/login", { password: "rahasia" });
		expect(res.status).toBe(400);
	});

	it("bentuk email ngawur ditolak 400", async () => {
		for (const email of ["bukan-email", "a@b", "a b@c.com", "@c.com"]) {
			const { res } = await post("/api/auth/login", { email, password: "x" });
			expect({ email, status: res.status }).toEqual({ email, status: 400 });
		}
	});

	it("tanpa x-device-id ditolak 400 sebelum database", async () => {
		// Aturan "tolak mutlak": akun terikat pada satu komputer, jadi
		// permintaan tanpa identitas komputer tidak bisa dilanjutkan.
		const { res, body } = await post("/api/auth/login", {
			email: "a@b.com",
			password: "rahasia123",
		});
		expect(res.status).toBe(400);
		expect(body.code).toBe("PERANGKAT_TIDAK_JELAS");
		expect(stopsAtDbGate(body)).toBe(false);
	});

	it("x-device-id terlalu pendek ditolak 400", async () => {
		const { res } = await post(
			"/api/auth/login",
			{ email: "a@b.com", password: "rahasia123" },
			{ "x-device-id": "abc" },
		);
		expect(res.status).toBe(400);
	});

	it("pasangan email+password yang sah LOLOS validasi (berhenti di gerbang DB)", async () => {
		const { res, body } = await post(
			"/api/auth/login",
			{
				email: "  User@Example.COM ",
				password: "rahasia123",
			},
			DEVICE,
		);
		// Normalisasi email (huruf kecil, dipangkas) + validasi panjang harus
		// meloloskan ini; kalau tidak, gerbang DB tak akan pernah tercapai.
		expect(res.status).toBe(500);
		expect(stopsAtDbGate(body)).toBe(true);
	});

	it("password kepanjangan ditolak sebelum database", async () => {
		const { res } = await post("/api/auth/login", {
			email: "a@b.com",
			password: "x".repeat(5_000),
		});
		expect(res.status).toBe(400);
	});

	it("body raksasa ditolak 413", async () => {
		const { res } = await post("/api/auth/login", {
			email: "a@b.com",
			password: "x",
			banjir: "y".repeat(20_000),
		});
		expect(res.status).toBe(413);
	});
});

describe("POST /api/auth/verify — validasi kode OTP", () => {
	it("kode bukan angka ditolak 400", async () => {
		const { res } = await post("/api/auth/verify", { email: "a@b.com", kode: "abcd" });
		expect(res.status).toBe(400);
	});

	it("kode terlalu pendek/panjang ditolak 400", async () => {
		for (const kode of ["123", "1234567", ""]) {
			const { res } = await post("/api/auth/verify", { email: "a@b.com", kode });
			expect({ kode, status: res.status }).toEqual({ kode, status: 400 });
		}
	});

	it("email ngawur ditolak 400", async () => {
		const { res } = await post("/api/auth/verify", { email: "bukan-email", kode: "1234" });
		expect(res.status).toBe(400);
	});

	it("tanpa x-device-id ditolak 400 sebelum database", async () => {
		// Verifikasi adalah lanjutan login; kalau tidak diperiksa, jalur ini
		// jadi celah yang melewati aturan satu komputer.
		const { res, body } = await post("/api/auth/verify", { email: "a@b.com", kode: "4321" });
		expect(res.status).toBe(400);
		expect(body.code).toBe("PERANGKAT_TIDAK_JELAS");
	});

	it("pasangan email+kode yang sah LOLOS validasi (berhenti di gerbang DB)", async () => {
		const { res, body } = await post(
			"/api/auth/verify",
			{
				email: "a@b.com",
				kode: "4321",
			},
			DEVICE,
		);
		expect(res.status).toBe(500);
		expect(stopsAtDbGate(body)).toBe(true);
	});

	it("menerima nama field `otp` sebagai ganti `kode`", async () => {
		const { res, body } = await post("/api/auth/verify", { email: "a@b.com", otp: "4321" }, DEVICE);
		expect(res.status).toBe(500);
		expect(stopsAtDbGate(body)).toBe(true);
	});
});

describe("POST /api/auth/resend-otp", () => {
	it("email wajib diisi", async () => {
		const { res } = await post("/api/auth/resend-otp", {});
		expect(res.status).toBe(400);
	});

	it("email ngawur ditolak 400", async () => {
		const { res } = await post("/api/auth/resend-otp", { email: "bukan-email" });
		expect(res.status).toBe(400);
	});

	it("email sah LOLOS validasi (berhenti di gerbang DB)", async () => {
		const { res, body } = await post("/api/auth/resend-otp", { email: "a@b.com" });
		expect(res.status).toBe(500);
		expect(stopsAtDbGate(body)).toBe(true);
	});
});

describe("rute yang butuh sesi — ditolak SEBELUM database dibuka", () => {
	/**
	 * Ini penjagaan penting: kalau token diperiksa setelah koneksi DB dibuka,
	 * permintaan tanpa token tetap membebani database — dan itu pintu masuk
	 * yang murah untuk membanjiri DB.
	 */
	it("GET /api/auth/me tanpa token ditolak 401, bukan 500", async () => {
		const { res } = await get("/api/auth/me");
		expect(res.status).toBe(401);
	});

	it("POST /api/auth/machine tanpa token ditolak 401", async () => {
		const { res } = await post("/api/auth/machine", { machine_info: "{}" });
		expect(res.status).toBe(401);
	});

	it("POST /api/auth/logout tanpa token ditolak 401", async () => {
		const { res } = await post("/api/auth/logout", {});
		expect(res.status).toBe(401);
	});

	it("token ngawur ditolak 401 tanpa menyentuh database", async () => {
		const { res } = await get("/api/auth/me", { "x-access-token": "token-ngawur" });
		expect(res.status).toBe(401);
	});

	it("token utuh palsu (tanda tangan salah) ditolak 401", async () => {
		const fake = `v1.1.${Math.floor(Date.now() / 1000) + 3600}.${"a".repeat(32)}.${"b".repeat(32)}`;
		const { res } = await get("/api/auth/me", { "x-access-token": fake });
		expect(res.status).toBe(401);
	});

	it("sidik jari tanpa X-User-Id ditolak 400", async () => {
		const { res } = await get("/api/auth/me", { "x-access-token": "c".repeat(32) });
		expect(res.status).toBe(400);
	});

	it("sidik jari + X-User-Id LOLOS validasi token (berhenti di gerbang DB)", async () => {
		// Pemeriksaan sesungguhnya (cocok dengan `sesi.th`) butuh database,
		// jadi yang dibuktikan di sini hanyalah: bentuknya lolos validasi
		// awal dan penolakannya bukan karena token.
		const { res, body } = await get("/api/auth/me", {
			"x-access-token": "c".repeat(32),
			"x-user-id": "1",
		});
		expect(res.status).toBe(500);
		expect(stopsAtDbGate(body)).toBe(true);
	});

	it("sidik jari yang bukan 32 huruf heksadesimal ditolak 401", async () => {
		for (const bad of ["bukan-hash", "z".repeat(32), "a".repeat(31)]) {
			const { res } = await get("/api/auth/me", { "x-access-token": bad, "x-user-id": "1" });
			expect({ bad, status: res.status }).toEqual({ bad, status: 401 });
		}
	});

	it("POST /api/auth/machine menolak sidik jari tanpa X-User-Id", async () => {
		const { res } = await post(
			"/api/auth/machine",
			{ machine_info: "{}" },
			{ "x-access-token": "c".repeat(32) },
		);
		expect(res.status).toBe(400);
	});

	it("POST /api/auth/machine menuntut field machine_info", async () => {
		const { res } = await post(
			"/api/auth/machine",
			{},
			{ "x-access-token": "c".repeat(32), "x-user-id": "1" },
		);
		expect(res.status).toBe(400);
	});

	it("machine_info kepanjangan ditolak 413 sebelum database", async () => {
		const { res } = await post(
			"/api/auth/machine",
			{ machine_info: "x".repeat(20_000) },
			{ "x-access-token": "c".repeat(32), "x-user-id": "1" },
		);
		expect(res.status).toBe(413);
	});
});

describe("rute auth tidak memakai gerbang write token", () => {
	/**
	 * Sengaja: write token itu rahasia milik operator, sedangkan rute auth
	 * dipanggil aplikasi user. Kalau tertukar, seluruh alur login akan mati.
	 */
	it("login tanpa x-write-token TIDAK ditolak 401/503 gerbang tulis", async () => {
		const { res, body } = await post(
			"/api/auth/login",
			{
				email: "a@b.com",
				password: "rahasia",
			},
			DEVICE,
		);
		expect([401, 503]).not.toContain(res.status);
		expect(stopsAtDbGate(body)).toBe(true);
	});
});
