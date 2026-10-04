/**
 * Tes lapisan HTTP: pencocokan rute, gerbang token, dan urutan validasi.
 *
 * Tes di sini TIDAK menyentuh database. `DIRECT_URL` sengaja dikosongkan di
 * vitest.config.mts, jadi rute yang lolos validasi berhenti di gerbang
 * "Secret DIRECT_URL belum di-set" (HTTP 500). Respons itu justru bukti:
 * tak ada koneksi database yang dibuka.
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { routeList } from "../src/index";

const BASE = "https://example.com";

describe("tabel rute", () => {
	it("melaporkan seluruh rute lewat routeList()", () => {
		expect(routeList()).toEqual([
			"GET /api/health",
			"GET /api/db/inspect",
			"GET /api/games",
			"GET /api/games/:game_id",
			"POST /api/auth/login",
			"POST /api/auth/verify",
			"POST /api/auth/resend-otp",
			"POST /api/auth/machine",
			"GET /api/auth/me",
			"POST /api/auth/logout",
			"POST /api/auth/recovery",
			"POST /api/claim-invoice",
			"GET /api/account",
		]);
	});

	it("GET /api/health membalas daftar rute yang sama", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.routes).toEqual(routeList());
	});
});

describe("rute yang tidak butuh database", () => {
	it("GET /api/health membalas 200 dan status binding", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.worker).toBe("worker-toko");
	});

	it("rute tidak dikenal membalas 404 dengan pesan yang jelas", async () => {
		const res = await SELF.fetch(`${BASE}/api/entah`);
		expect(res.status).toBe(404);
	});

	it("method salah pada jalur yang ada tetap 404, bukan 500", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});

describe("gerbang token & urutan validasi", () => {

	it("GET /api/db/inspect tanpa token ditolak sebelum menyentuh DB", async () => {
		const res = await SELF.fetch(`${BASE}/api/db/inspect`);
		expect([401, 503]).toContain(res.status);
	});

	it("GET /api/db/inspect?table=user ditolak walau token benar", async () => {
		const res = await SELF.fetch(`${BASE}/api/db/inspect?table=user`, {
			headers: { "x-write-token": "token-uji" },
		});
		// Token cocok di config tes, tabel tidak diizinkan -> 400 dari allowlist,
		// bukan daftar kolom tabel sensitif (user/password_hash).
		expect([400, 401]).toContain(res.status);
	});

});

describe("pencocokan jalur berparameter", () => {
	it("GET /api/games/:game_id dengan id bukan angka ditolak 400", async () => {
		const res = await SELF.fetch(`${BASE}/api/games/witcher`);
		expect(res.status).toBe(400);
	});

	it("id bukan angka murni juga ditolak (`620abc`, `-1`, `0`)", async () => {
		for (const bad of ["620abc", "-1", "0", "62 0", "99999999999999999"]) {
			const res = await SELF.fetch(`${BASE}/api/games/${encodeURIComponent(bad)}`);
			expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
		}
	});

	it("rute statis tidak tertelan pola berparameter", async () => {
		// Kalau `/api/games` ikut tercocokkan oleh /^\/api\/games\/([^/]+)$/,
		// id-nya akan dibaca dari segmen setelahnya dan ditolak 400. Kenyataannya
		// harus sampai ke gerbang DIRECT_URL (500) — artinya rute list yang menang.
		const res = await SELF.fetch(`${BASE}/api/games`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error)).toContain("DIRECT_URL");
	});

	it("detail game TIDAK lagi menyentuh database", async () => {
		// Sebelumnya rute ini berhenti di gerbang "DIRECT_URL belum di-set" (500).
		// Sekarang sumbernya Steam Store, jadi responsnya tidak boleh berupa galat
		// konfigurasi database. Status 200 kalau Steam menjawab, 404 kalau appid
		// tidak dikenal, dan 502 kalau tes berjalan tanpa jaringan.
		const res = await SELF.fetch(`${BASE}/api/games/620`);
		expect([200, 404, 502]).toContain(res.status);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error ?? "")).not.toContain("DIRECT_URL");
	});
});

describe("GET /api/games — pagination, search, filter", () => {
	/**
	 * Semua nilai parameter di bawah ini sah dan akan lolos `prepare()`, jadi
	 * responsnya berhenti di gerbang DIRECT_URL (500) — artinya validasi TIDAK
	 * menolak input yang benar, dan tidak ada koneksi DB yang dibuka.
	 *
	 * Ini membuktikan validasinya berjalan: kalau `readList()`/`readInt()`
	 * melempar error, statusnya 500 dengan pesan berbeda; kalau salah baca,
	 * bisa jadi 400.
	 */
	const accepted = [
		"?page=2&page_size=10",
		"?page_size=100&page=10000",
		"?search=witcher",
		"?search=100%25&search=a_b", // wildcard LIKE harus dinetralkan
		"?category=RPG&category=Action",
		"?category=RPG,Action",
		"?genre=RPG&genre=Action,Puzzle",
		"?tags=open-world&tags=co-op",
		"?category=RPG&genre=Action&tags=open-world&search=witcher&page=2&page_size=5",
		"?page_size=99999", // dijepit ke maksimum, bukan ditolak
		"?page=-5", // dijepit ke 1, bukan ditolak
	];

	for (const query of accepted) {
		it(`${query} lolos validasi`, async () => {
			const res = await SELF.fetch(`${BASE}/api/games${query}`);
			expect(res.status).toBe(500);
			const body = (await res.json()) as Record<string, unknown>;
			expect(String(body.error)).toContain("DIRECT_URL");
		});
	}

	it("parameter lama `limit`/`offset`/`q` tidak dipakai lagi", async () => {
		// Bukan error, hanya diabaikan: permintaan tetap lolos validasi.
		// Ini menjaga nama parameter tetap satu gaya (page/page_size/search).
		const res = await SELF.fetch(`${BASE}/api/games?limit=10&offset=5&q=witcher`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error)).toContain("DIRECT_URL");
	});
});
