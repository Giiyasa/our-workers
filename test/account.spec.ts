/**
 * Tes GET /api/account — lapisan HTTP, TANPA database.
 *
 * Sama seperti tes rute bersesi lain: `DIRECT_URL` dikosongkan di
 * vitest.config.mts, jadi permintaan yang lolos seluruh pemeriksaan sesi
 * berhenti di gerbang "Secret DIRECT_URL belum di-set" (500) — dan itu justru
 * bukti pemeriksaannya berjalan tanpa membuka koneksi.
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "https://example.com";

/**
 * Header sesi jalur sidik jari (bentuk sah menurut preflightSession):
 * token = MD5 heksadesimal 32 huruf + user_id angka. Isinya tidak dicocokkan
 * ke database di tahap ini — pencocokan terjadi di handle(), yang berhenti di
 * gerbang DIRECT_URL pada tes ini.
 */
const SESSION = {
	"x-access-token": "b7a3f5c1d9e24680a1b2c3d4e5f60718",
	"x-user-id": "12",
	"x-device-id": "b7a3f5c1d9e24680a1b2c3d4e5f60718",
};

async function get(headers: Record<string, string> = SESSION) {
	const res = await SELF.fetch(`${BASE}/api/account`, { headers });
	const parsed = (await res.json()) as Record<string, unknown>;
	return { res, body: parsed };
}

describe("GET /api/account — sesi", () => {
	it("tanpa X-Access-Token ditolak 401", async () => {
		const { res } = await get({});
		expect(res.status).toBe(401);
	});

	it("token bukan token utuh dan bukan sidik jari ditolak 401", async () => {
		const { res } = await get({
			"x-access-token": "ngawur",
			"x-user-id": "12",
		});
		expect(res.status).toBe(401);
	});

	it("sidik jari tanpa X-User-Id ditolak 400 (USER_ID_TIDAK_ADA — salah bentuk, bukan sesi mati)", async () => {
		const { res, body } = await get({
			"x-access-token": "b7a3f5c1d9e24680a1b2c3d4e5f60718",
		});
		expect(res.status).toBe(400);
		expect(body.code).toBe("USER_ID_TIDAK_ADA");
	});
});

describe("GET /api/account — lolos pemeriksaan sesi berhenti di gerbang DB", () => {
	it("permintaan bersesi sah berhenti di gerbang DIRECT_URL (500), bukan galat lain", async () => {
		const { res, body } = await get();
		expect(res.status).toBe(500);
		expect(String(body.error)).toContain("DIRECT_URL");
	});

	it("rute terdaftar di daftar rute health", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.routes).toContain("GET /api/account");
	});
});
