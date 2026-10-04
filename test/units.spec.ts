/**
 * Tes unit murni: fungsi yang bisa diuji tanpa Worker, tanpa HTTP, tanpa DB.
 *
 * Semua fungsi di sini menerima argumen dan mengembalikan nilai, jadi tesnya
 * cepat dan tidak bisa "diam-diam" menyentuh database.
 */

import { describe, it, expect } from "vitest";
import { scrub } from "../src/lib/http";
import { escapeLike, readBool, readInt, readList } from "../src/lib/params";
import {
	fetchSteamDetail,
	mapWithLimit,
	pickImageUrl,
	shapeSteamDetail,
	toSteamAppId,
} from "../src/lib/steam";
import { shapeGame } from "../src/shape";

describe("shapeGame() — bentuk baris game_list tabel baru", () => {
	const rowFull = {
		id: "1",
		app_id: "10",
		name: "Counter-Strike",
		image: "shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg?t=1745368572",
		description: "Play the world's number 1 online action game.",
		genre: ["Action", "Shooter"],
		categories: ["Multi-player", "PvP", "Online PvP"],
		publishers: ["Valve", "Valve Corporation"],
		release_date: "2000-11-01",
		created_at: "2026-10-03 08:30:27.484313+00",
		updated_at: "2026-10-03 08:30:27.484313+00",
	};

	const rowMinimal = {
		id: 2,
		app_id: 999,
		name: "Tanpa Gambar",
		image: null,
		description: null,
		genre: null,
		categories: null,
		publishers: null,
		release_date: null,
	};

	it("kolom array jsonb tetap array, image diberi https://", () => {
		const g = shapeGame(rowFull);
		expect(g.app_id).toBe("10");
		expect(g.name).toBe("Counter-Strike");
		expect(g.genre).toEqual(["Action", "Shooter"]);
		expect(g.categories).toEqual(["Multi-player", "PvP", "Online PvP"]);
		expect(g.publishers).toEqual(["Valve", "Valve Corporation"]);
		expect(g.release_date).toBe("2000-11-01");
		expect(g.image).toBe(
			"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg?t=1745368572",
		);
	});

	it("image yang sudah punya protokol / // di depan tidak dirusak", () => {
		expect(
			shapeGame({ ...rowFull, image: "https://cdn.example/x.jpg" }).image,
		).toBe("https://cdn.example/x.jpg");
		expect(shapeGame({ ...rowFull, image: "//cdn.example/x.jpg" }).image).toBe(
			"https://cdn.example/x.jpg",
		);
	});

	it("kolom teks dipisah koma tetap diratakan jadi array", () => {
		const g = shapeGame({ ...rowFull, genre: "Action, Shooter" });
		expect(g.genre).toEqual(["Action", "Shooter"]);
	});

	it("kolom null dibiarkan null / array kosong, bukan error", () => {
		const g = shapeGame(rowMinimal);
		expect(g.image).toBeNull();
		expect(g.description).toBeNull();
		expect(g.release_date).toBeNull();
		expect(g.genre).toEqual([]);
		expect(g.categories).toEqual([]);
		expect(g.publishers).toEqual([]);
	});

	it("field versi lama sekali tidak dipakai lagi", () => {
		const g = shapeGame(rowFull);
		expect(Object.keys(g)).not.toContain("asset");
		expect(Object.keys(g)).not.toContain("header_image");
		expect(Object.keys(g)).not.toContain("tags");
	});

	it("literal array Postgres (fetch_types:false) dipecah benar", () => {
		// Bentuk nyata yang datang dari worker: kolom text[] tidak diparse
		// driver (fetch_types:false di lib/db.ts), jadi 1 baris = 1 string.
		const g = shapeGame({
			...rowFull,
			genre: '{"Adventure","Casual","Simulation"}',
			categories: '{"Single-player","Family Sharing"}',
			publishers: '{"Ben Koder"}',
		});
		expect(g.genre).toEqual(["Adventure", "Casual", "Simulation"]);
		expect(g.categories).toEqual(["Single-player", "Family Sharing"]);
		expect(g.publishers).toEqual(["Ben Koder"]);
	});

	it("literal array Postgres: elemen ber-koma & kutip di-escape benar", () => {
		// "Gun, Rose" dan nama ber-kutip tidak boleh terpecah di salah tempat.
		const g = shapeGame({
			...rowFull,
			genre: '{"Action","Gun, Rose"}',
			publishers: '{"\\"Ben Koder\\""}',
		});
		expect(g.genre).toEqual(["Action", "Gun, Rose"]);
		expect(g.publishers).toEqual(['"Ben Koder"']);
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

describe("toSteamAppId() — saring nilai game_id sebelum menembak Steam", () => {
	it("menerima angka wajar, termasuk yang datang sebagai teks", () => {
		expect(toSteamAppId(620)).toBe(620);
		expect(toSteamAppId("620")).toBe(620);
		expect(toSteamAppId(" 578080 ")).toBe(578080);
	});

	it("menolak nilai yang tidak layak jadi appid", () => {
		for (const bad of [null, undefined, "", "  ", "abc", 0, -5, 12.5, "620,730", {}, []]) {
			expect(toSteamAppId(bad)).toBeNull();
		}
	});

	it("menolak angka di luar rentang appid Steam", () => {
		expect(toSteamAppId(4_294_967_296)).toBeNull();
		expect(toSteamAppId(4_294_967_295)).toBe(4_294_967_295);
	});
});

describe("pickImageUrl() — saring URL gambar dari Steam", () => {
	it("menerima alamat http(s)", () => {
		expect(pickImageUrl("https://x/shot.jpg")).toBe("https://x/shot.jpg");
		expect(pickImageUrl("http://x/shot.jpg")).toBe("http://x/shot.jpg");
	});

	it("menolak nilai yang tidak layak dipasang di <img src>", () => {
		for (const bad of [
			null,
			undefined,
			123,
			"",
			"   ",
			"javascript:alert(1)",
			"data:image/png;base64,AAAA",
			"x".repeat(600),
		]) {
			expect(pickImageUrl(bad)).toBeNull();
		}
	});
});

describe("shapeSteamDetail() — tujuh field yang dikirim ke client", () => {
	// Potongan respons appdetails asli (PUBG 578080), dipendekkan.
	const steamData = {
		name: "PUBG: BATTLEGROUNDS",
		type: "game",
		steam_appid: 578080,
		is_free: true,
		detailed_description: "<p>Drop into the Battlegrounds.</p>",
		short_description: "Battle Royale, free-to-play!",
		pc_requirements: {
			minimum: "<strong>Minimum:</strong><br><ul><li>OS: Windows 10</li></ul>",
			recommended: "",
		},
		categories: [
			{ id: 1, description: "Multi-player" },
			{ id: 49, description: "PvP" },
			{ id: 36, description: "   " },
			null,
		],
		genres: [
			{ id: "1", description: "Action" },
			{ id: "37", description: "Free To Play" },
		],
		screenshots: [
			{
				id: 0,
				path_thumbnail: "https://shared.akamai.steamstatic.com/a.600x338.jpg",
				path_full: "https://shared.akamai.steamstatic.com/a.1920x1080.jpg",
			},
			{ id: 1, path_thumbnail: "javascript:alert(1)", path_full: "" },
		],
		movies: [{ id: 1, name: "Trailer" }],
		release_date: { date: "Dec 21, 2017" },
	};

	it("mengambil ketujuh field dengan nama JSON yang diminta", () => {
		const detail = shapeSteamDetail(steamData);
		expect(Object.keys(detail)).toEqual([
			"name",
			"detailed_description",
			"short_description",
			"pc_requirements",
			"categories",
			"genres",
			"screenshots",
		]);
		expect(detail.name).toBe("PUBG: BATTLEGROUNDS");
		expect(detail.short_description).toBe("Battle Royale, free-to-play!");
	});

	it("membuang field Steam yang tidak diminta", () => {
		const detail = shapeSteamDetail(steamData) as unknown as Record<string, unknown>;
		for (const dropped of ["movies", "release_date", "is_free", "type", "steam_appid"]) {
			expect(detail[dropped]).toBeUndefined();
		}
	});

	it("categories & genres jadi [{id, description}], entri kosong dibuang", () => {
		const detail = shapeSteamDetail(steamData);
		expect(detail.categories).toEqual([
			{ id: 1, description: "Multi-player" },
			{ id: 49, description: "PvP" },
		]);
		// id genre dari Steam berupa string — dibiarkan apa adanya.
		expect(detail.genres).toEqual([
			{ id: "1", description: "Action" },
			{ id: "37", description: "Free To Play" },
		]);
	});

	it("screenshots jadi [{id, thumbnail, full}] dan URL tak layak dibuang", () => {
		const detail = shapeSteamDetail(steamData);
		expect(detail.screenshots).toEqual([
			{
				id: 0,
				thumbnail: "https://shared.akamai.steamstatic.com/a.600x338.jpg",
				full: "https://shared.akamai.steamstatic.com/a.1920x1080.jpg",
			},
		]);
	});

	it("pc_requirements dipertahankan apa adanya, string kosong dibuang", () => {
		const detail = shapeSteamDetail(steamData);
		expect(detail.pc_requirements).toEqual({
			minimum: "<strong>Minimum:</strong><br><ul><li>OS: Windows 10</li></ul>",
		});
	});

	it("game tanpa sysreq: pc_requirements null, bukan {}", () => {
		expect(shapeSteamDetail({ name: "x", pc_requirements: {} }).pc_requirements).toBeNull();
		expect(shapeSteamDetail({ name: "x", pc_requirements: [] }).pc_requirements).toBeNull();
		expect(shapeSteamDetail({ name: "x" }).pc_requirements).toBeNull();
	});

	it("field yang hilang jadi null/[] supaya bentuk responsnya selalu sama", () => {
		const detail = shapeSteamDetail({});
		expect(detail).toEqual({
			name: null,
			detailed_description: null,
			short_description: null,
			pc_requirements: null,
			categories: [],
			genres: [],
			screenshots: [],
		});
	});

	it("nilai ngawur tidak membuat runtuh", () => {
		const detail = shapeSteamDetail({
			name: 123,
			detailed_description: null,
			categories: "bukan array",
			genres: {},
			screenshots: [null, "x"],
		} as Record<string, any>);
		expect(detail.name).toBeNull();
		expect(detail.categories).toEqual([]);
		expect(detail.genres).toEqual([]);
		expect(detail.screenshots).toEqual([]);
	});
});

describe("fetchSteamDetail() — ambil detail dari Steam Store", () => {
	const okPayload = {
		"578080": {
			success: true,
			data: {
				name: "PUBG: BATTLEGROUNDS",
				short_description: "Battle Royale",
				detailed_description: "<p>x</p>",
				pc_requirements: { minimum: "Windows 10" },
				categories: [{ id: 1, description: "Multi-player" }],
				genres: [{ id: "1", description: "Action" }],
				screenshots: [
					{
						id: 0,
						path_thumbnail: "https://x/t.jpg",
						path_full: "https://x/f.jpg",
					},
				],
			},
		},
	};

	/** fetch tiruan: mencatat URL yang diminta, membalas payload yang ditentukan. */
	function fakeFetch(payload: unknown, status = 200) {
		const calls: string[] = [];
		const fetcher = (async (url: string) => {
			calls.push(String(url));
			return new Response(JSON.stringify(payload), {
				status,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		return { calls, fetcher };
	}

	it("meminta appdetails TANPA filters=basic (field lengkap dibutuhkan)", async () => {
		const { calls, fetcher } = fakeFetch(okPayload);
		const result = await fetchSteamDetail(578080, fetcher);
		expect(result.ok).toBe(true);
		expect(calls[0]).toContain("/api/appdetails?appids=578080");
		expect(calls[0]).toContain("cc=us");
		expect(calls[0]).not.toContain("filters");
	});

	it("success true -> detail terisi", async () => {
		const { fetcher } = fakeFetch(okPayload);
		const result = await fetchSteamDetail(578080, fetcher);
		expect(result.ok && result.detail.name).toBe("PUBG: BATTLEGROUNDS");
		expect(result.ok && result.detail.screenshots).toHaveLength(1);
	});

	it("success false -> unknown (Steam hidup, appid tidak ada)", async () => {
		const { fetcher } = fakeFetch({ "578080": { success: false } });
		expect(await fetchSteamDetail(578080, fetcher)).toEqual({
			ok: false,
			reason: "unknown",
		});
	});

	it("status HTTP non-200 -> unreachable, bukan unknown", async () => {
		for (const status of [429, 403, 500, 503]) {
			const { fetcher } = fakeFetch({}, status);
			expect(await fetchSteamDetail(578080, fetcher)).toEqual({
				ok: false,
				reason: "unreachable",
			});
		}
	});

	it("JSON rusak / fetch melempar -> unreachable", async () => {
		const bad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
		expect(await fetchSteamDetail(578080, bad)).toEqual({
			ok: false,
			reason: "unreachable",
		});

		const boom = (async () => {
			throw new Error("koneksi mati");
		}) as unknown as typeof fetch;
		expect(await fetchSteamDetail(578080, boom)).toEqual({
			ok: false,
			reason: "unreachable",
		});
	});

	it("appid di luar rentang -> unknown tanpa memanggil Steam sama sekali", async () => {
		let called = 0;
		const fetcher = (async () => {
			called++;
			return new Response("{}");
		}) as unknown as typeof fetch;
		expect(await fetchSteamDetail(4_294_967_296, fetcher)).toEqual({
			ok: false,
			reason: "unknown",
		});
		expect(called).toBe(0);
	});
});

describe("mapWithLimit() — paralel dengan jumlah pekerjaan dibatasi", () => {
	it("hasil sejajar dengan urutan masukan", async () => {
		const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40, 50]);
	});

	it("tidak pernah melebihi batas serempak", async () => {
		let running = 0;
		let peak = 0;
		await mapWithLimit(Array.from({ length: 30 }, (_, i) => i), 4, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running--;
			return n;
		});
		expect(peak).toBeLessThanOrEqual(4);
	});

	it("daftar kosong selesai tanpa memanggil apa pun", async () => {
		let calls = 0;
		const out = await mapWithLimit([], 8, async () => calls++);
		expect(out).toEqual([]);
		expect(calls).toBe(0);
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
