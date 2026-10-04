/**
 * Tes POST /api/claim-invoice — lapisan HTTP, TANPA database.
 *
 * Sama seperti tes auth lain: `DIRECT_URL` dikosongkan di vitest.config.mts,
 * jadi permintaan yang lolos seluruh validasi berhenti di gerbang
 * "Secret DIRECT_URL belum di-set" (500) — dan itu justru bukti validasinya
 * berjalan tanpa membuka koneksi.
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
	const res = await SELF.fetch(`${BASE}/api/claim-invoice`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const parsed = (await res.json()) as Record<string, unknown>;
	return { res, body: parsed };
}

describe("POST /api/claim-invoice — sesi", () => {
	it("tanpa X-Access-Token ditolak 401", async () => {
		const { res } = await post({ invoice_number: "INV-1" }, {});
		expect(res.status).toBe(401);
	});

	it("token bukan token utuh dan bukan sidik jari ditolak 401", async () => {
		const { res } = await post({ invoice_number: "INV-1" }, {
			"x-access-token": "ngawur",
			"x-user-id": "12",
		});
		expect(res.status).toBe(401);
	});

	it("sidik jari tanpa X-User-Id ditolak 400 (USER_ID_TIDAK_ADA — salah bentuk, bukan sesi mati)", async () => {
		const { res, body } = await post({ invoice_number: "INV-1" }, {
			"x-access-token": "b7a3f5c1d9e24680a1b2c3d4e5f60718",
		});
		expect(res.status).toBe(400);
		expect(body.code).toBe("USER_ID_TIDAK_ADA");
	});
});

describe("POST /api/claim-invoice — validasi body sebelum database", () => {
	it("body kosong ditolak 400", async () => {
		const { res } = await post("");
		expect(res.status).toBe(400);
	});

	it("bukan JSON ditolak 400", async () => {
		const { res } = await post("{rusak");
		expect(res.status).toBe(400);
	});

	it("invoice_number kosong ditolak 400", async () => {
		const { res, body } = await post({ invoice_number: "   " });
		expect(res.status).toBe(400);
		expect(String(body.error)).toContain("invoice_number");
	});

	it("invoice_number lebih panjang dari batas ditolak 400", async () => {
		const { res } = await post({ invoice_number: "A".repeat(65) });
		expect(res.status).toBe(400);
	});
});

describe("POST /api/claim-invoice — lolos validasi berhenti di gerbang DB", () => {
	it("permintaan sah berhenti di gerbang DIRECT_URL (500), bukan galat lain", async () => {
		const { res, body } = await post({ invoice_number: "INV-2026-0001" });
		expect(res.status).toBe(500);
		expect(String(body.error)).toContain("DIRECT_URL");
	});

	it("rute terdaftar di daftar rute health", async () => {
		const res = await SELF.fetch(`${BASE}/api/health`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.routes).toContain("POST /api/claim-invoice");
	});
});
