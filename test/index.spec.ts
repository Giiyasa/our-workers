import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { scrub, shapeGame, readInt } from "../src/index";

describe("rute yang tidak butuh database", () => {
	it("GET /api/health membalas 200 dan status binding", async () => {
		const res = await SELF.fetch("https://example.com/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.worker).toBe("worker-toko");
	});

	it("rute tidak dikenal membalas 404 dengan pesan yang jelas", async () => {
		const res = await SELF.fetch("https://example.com/api/entah");
		expect(res.status).toBe(404);
	});

	it("POST /api/games tanpa token ditolak 401 sebelum menyentuh DB", async () => {
		const res = await SELF.fetch("https://example.com/api/games", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ game_name: "x" }),
		});
		expect([401, 503]).toContain(res.status);
	});

	it("GET /api/db/inspect tanpa token ditolak sebelum menyentuh DB", async () => {
		const res = await SELF.fetch("https://example.com/api/db/inspect");
		expect([401, 503]).toContain(res.status);
	});

	it("GET /api/db/inspect?table=user ditolak walau token benar", async () => {
		const res = await SELF.fetch("https://example.com/api/db/inspect?table=user", {
			headers: { "x-write-token": "token-uji" },
		});
		// Token cocok di config tes, tabel tidak diizinkan -> 400 dari allowlist,
		// bukan daftar kolom tabel sensitif (user/password_hash).
		expect([400, 401]).toContain(res.status);
	});

	it("GET /api/games/:game_id dengan id bukan angka ditolak 400", async () => {
		const res = await SELF.fetch("https://example.com/api/games/witcher");
		expect(res.status).toBe(400);
	});

	it("POST /api/games dengan body kosong ditolak 400", async () => {
		const res = await SELF.fetch("https://example.com/api/games", {
			method: "POST",
			headers: { "content-type": "application/json", "x-write-token": "token-uji" },
			body: JSON.stringify({}),
		});
		expect([400, 401]).toContain(res.status);
	});

	it("rute sah tetap berhenti di gerbang DIRECT_URL (bukti tidak diam-diam ke DB)", async () => {
		// DIRECT_URL sengaja kosong di vitest.config.mts, jadi respons 500 yang
		// menyebut DIRECT_URL membuktikan tak ada koneksi database yang dibuka.
		const res = await SELF.fetch("https://example.com/api/games");
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error)).toContain("DIRECT_URL");
	});
});

describe("shapeGame() — bentuk hasil LEFT JOIN", () => {
	const rowWithAsset = {
		id: 1,
		game_id: 620,
		game_name: "Portal 2",
		description: "teka-teki",
		category: "action",
		genre: "puzzle",
		tags: "koop",
		previev_url_img: "https://contoh/1.jpg",
		created_at: "2026-01-01",
		updated_at: "2026-01-02",
		asset_game_id: 620,
		asset_created_at: "2026-01-01",
		asset_updated_at: "2026-01-02",
		asset_lua_data: "{}",
		asset_metadata: '{"appid":10,"name":"Counter-Strike"}',
		asset_encyription: null,
	};

	const rowWithoutAsset = {
		id: 2,
		game_id: 999,
		game_name: "Belum Punya Asset",
		description: null,
		category: null,
		genre: null,
		tags: null,
		previev_url_img: null,
		created_at: null,
		updated_at: null,
		asset_game_id: null,
		asset_created_at: null,
		asset_updated_at: null,
		asset_lua_data: null,
		asset_metadata: null,
		asset_encyription: null,
	};

	it("game dengan asset: asset.has_asset true dan game_id tetap dari game_list", () => {
		const g = shapeGame(rowWithAsset, true);
		expect(g.asset.has_asset).toBe(true);
		expect(g.game_id).toBe(620);
		expect(g.game_name).toBe("Portal 2");
	});

	it("game tanpa asset: asset.has_asset false, bukan error", () => {
		const g = shapeGame(rowWithoutAsset, true);
		expect(g.asset.has_asset).toBe(false);
		expect(g.asset.metadata).toBeNull();
	});

	it("mode penuh membentuk metadata_json dari teks JSON", () => {
		const g = shapeGame(rowWithAsset, true);
		expect(g.asset.metadata_json).toEqual({ appid: 10, name: "Counter-Strike" });
	});

	it("mode ringkas hanya melaporkan ukuran, bukan isi", () => {
		const g = shapeGame(
			{ ...rowWithAsset, asset_lua_bytes: 2, asset_metadata_bytes: 33, asset_ency_bytes: null },
			false,
		);
		expect(g.asset.metadata_bytes).toBe(33);
		expect(g.asset.metadata).toBeUndefined();
	});

	it("metadata yang bukan JSON tidak membuat runtuh", () => {
		const g = shapeGame({ ...rowWithAsset, asset_metadata: "{rusak" }, true);
		expect(g.asset.metadata_json).toBeNull();
		expect(g.asset.metadata).toBe("{rusak");
	});
});

describe("readInt() — pembaca angka query string", () => {
	it("null dan string kosong memakai nilai bawaan, BUKAN 0", () => {
		// Bug nyata: Number(null) === 0, jadi tanpa penjagaan ini permintaan
		// tanpa ?limit= akan diam-diam memakai limit 0 (hanya 1 baris terkirim).
		expect(readInt(null, 50, 1, 200)).toBe(50);
		expect(readInt("", 50, 1, 200)).toBe(50);
		expect(readInt("   ", 50, 1, 200)).toBe(50);
	});

	it("membaca angka biasa", () => {
		expect(readInt("25", 50, 1, 200)).toBe(25);
		expect(readInt("0", 50, 0, 200)).toBe(0);
	});

	it("menjepit ke batas min/maks", () => {
		expect(readInt("9999", 50, 1, 200)).toBe(200);
		expect(readInt("-5", 50, 0, 200)).toBe(0);
	});

	it("nilai ngawur memakai nilai bawaan", () => {
		expect(readInt("abc", 50, 1, 200)).toBe(50);
		expect(readInt("NaN", 50, 1, 200)).toBe(50);
		expect(readInt("12.7", 50, 1, 200)).toBe(12);
	});
});

describe("scrub() — jaring pengaman kebocoran rahasia", () => {
	it("menyensor connection string lengkap dengan password", () => {
		const message =
			"connect ECONNREFUSED postgresql://postgres:rahasia123@db.abc.supabase.co:5432/postgres";
		const result = scrub(message);
		expect(result).not.toContain("rahasia123");
		expect(result).toContain("[RAHASIA DISENSOR]");
	});

	it("menyensor secret key gaya baru", () => {
		expect(scrub("apikey sb_secret_AbC123xyz salah")).not.toContain("sb_secret_AbC123xyz");
	});

	it("menyensor JWT (anon/service_role gaya lama)", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop";
		const result = scrub(`header apikey ${jwt} ditolak`);
		expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
		expect(result).toContain("[RAHASIA DISENSOR]");
	});

	it("tetap membaca Error object, bukan cuma string", () => {
		const err = new Error("gagal ke postgres://u:p@host:5432/db");
		expect(scrub(err)).not.toContain("u:p@host");
	});

	it("tidak mengubah pesan yang tidak berisi rahasia", () => {
		expect(scrub(new Error('relation "game_list" does not exist'))).toContain(
			"does not exist",
		);
	});
});
