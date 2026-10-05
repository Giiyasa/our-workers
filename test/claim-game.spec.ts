/**
 * Tes POST /api/claim-game — lapisan HTTP, TANPA database & TANPA jaringan.
 *
 * Sama seperti tes claim-invoice: `DIRECT_URL` dikosongkan di vitest.config.mts
 * (binding dipaksa miniflare), jadi permintaan yang lolos seluruh validasi
 * berhenti di gerbang "Secret DIRECT_URL belum di-set" (500) — dan itu justru
 * bukti validasinya berjalan tanpa membuka koneksi. R2_* juga kosong di mode
 * tes: seandainya ada yang lolos sampai fetchR2Lua, balasannya 503 bukan
 * jaringan sungguhan.
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

async function post(body: unknown, headers: Record<string, string> = SESSION) {
	const res = await SELF.fetch(`${BASE}/api/claim-game`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// balasan biner (200) dibiarkan null
	}
	return { res, body: parsed, text };
}

describe("POST /api/claim-game — sesi", () => {
	it("tanpa X-Access-Token ditolak 401", async () => {
		const { res } = await post({ game_id: 570 }, {});
		expect(res.status).toBe(401);
	});

	it("token ngawur (bukan token utuh & bukan sidik jari) ditolak 401", async () => {
		const { res } = await post({ game_id: 570 }, {
			"x-access-token": "ngawur",
			"x-user-id": "12",
		});
		expect(res.status).toBe(401);
	});

	it("sidik jari tanpa X-User-Id ditolak 400 (USER_ID_TIDAK_ADA — salah bentuk, bukan sesi mati)", async () => {
		const { res, body } = await post({ game_id: 570 }, {
			"x-access-token": "b7a3f5c1d9e24680a1b2c3d4e5f60718",
		});
		expect(res.status).toBe(400);
		expect(body?.code).toBe("USER_ID_TIDAK_ADA");
	});
});

describe("POST /api/claim-game — validasi body sebelum database", () => {
	it("body kosong ditolak 400", async () => {
		const { res } = await post("");
		expect(res.status).toBe(400);
	});

	it("bukan JSON ditolak 400", async () => {
		const { res } = await post("{rusak");
		expect(res.status).toBe(400);
	});

	it("game_id tidak ada ditolak 400", async () => {
		const { res } = await post({});
		expect(res.status).toBe(400);
	});

	it("game_id bukan angka ditolak 400", async () => {
		const { res, body } = await post({ game_id: "62abc" });
		expect(res.status).toBe(400);
		expect(String(body?.error)).toContain("game_id");
	});

	it("game_id nol / negatif ditolak 400", async () => {
		const { res } = await post({ game_id: 0 });
		expect(res.status).toBe(400);
	});

	it("game_id di atas batas appid ditolak 400", async () => {
		const { res } = await post({ game_id: 5_000_000_000 });
		expect(res.status).toBe(400);
	});
});

describe("POST /api/claim-game — lolos validasi berhenti di gerbang DB", () => {
	it("permintaan sah berhenti di gerbang DIRECT_URL (500), bukan galat lain", async () => {
		const { res, body } = await post({ game_id: 570 });
		expect(res.status).toBe(500);
		expect(String(body?.error)).toContain("DIRECT_URL");
	});

	it("game_id sebagai string angka diterima validasinya (juga berhenti di gerbang DB)", async () => {
		const { res } = await post({ game_id: "570" });
		expect(res.status).toBe(500);
	});
});

describe("POST /api/claim-game — pendaftaran rute", () => {
	it("rute terdaftar di daftar rute health", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.routes).toContain("POST /api/claim-game");
	});
});
