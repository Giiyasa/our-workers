/**
 * Tes unit murni: fungsi yang bisa diuji tanpa Worker, tanpa HTTP, tanpa DB.
 *
 * Semua fungsi di sini menerima argumen dan mengembalikan nilai, jadi tesnya
 * cepat dan tidak bisa "diam-diam" menyentuh database.
 */

import { describe, it, expect } from "vitest";
import { scrub } from "../src/lib/http";
import { escapeLike, readBool, readInt, readList } from "../src/lib/params";
import { shapeGame } from "../src/shape";

describe("shapeGame() — bentuk hasil LEFT JOIN", () => {
	const rowWithAsset = {
		id: 1,
		game_id: 620,
		game_name: "Portal 2",
		description: "teka-teki",
		category: "action",
		genre: "puzzle",
		tags: "koop",
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

describe("readBool() — bendera query string", () => {
	it("menerima beberapa penulisan 'ya'", () => {
		for (const v of ["1", "true", "TRUE", "ya", "yes", "on"]) {
			expect(readBool(v)).toBe(true);
		}
	});

	it("null/kosong memakai nilai bawaan, bukan true", () => {
		expect(readBool(null)).toBe(false);
		expect(readBool("")).toBe(false);
		expect(readBool(null, true)).toBe(true);
	});

	it("nilai ngawur memakai nilai bawaan", () => {
		expect(readBool("0")).toBe(false);
		expect(readBool("nggak")).toBe(false);
	});
});

describe("escapeLike() — netralkan wildcard LIKE", () => {
	it("memberi pelindung pada % dan _ dan backslash", () => {
		expect(escapeLike("100%")).toBe("100\\%");
		expect(escapeLike("a_b")).toBe("a\\_b");
		expect(escapeLike("c:\\x")).toBe("c:\\\\x");
	});

	it("teks biasa tidak berubah", () => {
		expect(escapeLike("witcher 3")).toBe("witcher 3");
	});
});

describe("readList() — filter multi-nilai", () => {
	it("menerima nilai berulang", () => {
		expect(readList(["RPG", "Action"])).toEqual(["RPG", "Action"]);
	});

	it("menerima nilai dipisah koma, termasuk campuran dengan cara berulang", () => {
		expect(readList(["RPG,Action"])).toEqual(["RPG", "Action"]);
		expect(readList(["RPG", "Action,Puzzle"])).toEqual(["RPG", "Action", "Puzzle"]);
	});

	it("membuang nilai kosong dan spasi berlebih", () => {
		expect(readList(["", "  ", " RPG , "])).toEqual(["RPG"]);
	});

	it("membuang duplikat tanpa peduli huruf besar/kecil, urutan pertama menang", () => {
		expect(readList(["rpg", "RPG", "Action", "action"])).toEqual(["rpg", "Action"]);
	});

	it("membatasi jumlah nilai supaya URL raksasa tidak jadi query berat", () => {
		const many = Array.from({ length: 120 }, (_, i) => `v${i}`);
		expect(readList(many)).toHaveLength(50);
	});

	it("memotong nilai yang kepanjangan", () => {
		expect(readList(["x".repeat(200)])[0]).toHaveLength(64);
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
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijklmnop";
		const result = scrub(`header apikey ${jwt} ditolak`);
		expect(result).not.toContain(jwt);
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
