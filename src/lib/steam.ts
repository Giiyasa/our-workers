/**
 * Ambil `header_image` dari Steam Store (appdetails).
 *
 * Dipakai GET /api/games untuk menambah `header_image` di tiap game pada
 * halaman yang sedang ditampilkan saja (maksimum = page_size).
 *
 * ATURAN PENTING — jangan diubah tanpa alasan kuat:
 *
 * 1. SATU GAME = SATU SUBREQUEST.
 *    `?appids=620,730` (koma) DITOLAK Steam dengan HTTP 400 "null" meski
 *    permintaan yang sama secara manual berhasil dari browser/curl. Jadi
 *    "hemat subrequest" TIDAK BISA dilakukan lewat appid gabungan. Yang
 *    tersedia hanya `?appids=620&appids=730` (parameter diulang), tapi
 *    responsnya ArrayBuffer yang harus di-decode manual — fragile, tetap
 *    butuh beberapa subrequest untuk 25-100 game, dan lebih rawan pecah
 *    kalau Steam mengubah format. Karena itu dipakai satu permintaan per
 *    game: jalur yang sama dengan contoh di dokumentasi.
 *
 * 2. `filters=basic` WAJIB.
 *    Tanpa filter, respons satu game ±28 KB (screenshots, movies, dlc,
 *    requirements). Dengan `filters=basic` ±2,3 KB dan tetap memuat
 *    `header_image`. Ini bukan sekadar hemat bandwidth: respons kecil lebih
 *    cepat di-parse dan lebih jarang kena potong.
 *
 * 3. PARALEL, TAPI DIBATASI.
 *    Rute ini serempak membuka `max` koneksi; tiap koneksi menahan satu slot
 *    tunggu. Jadi ambil gambar selalu paralel (kalau berurutan, 25 game ×
 *    ±350 ms = ±9 detik). Batasnya di config: `STEAM_FETCH_CONCURRENCY`.
 *
 * 4. GAGAL = NULL, BUKAN ERROR.
 *    Steam tidak sanggup/ratelimit/timeout/konten bukan game (DLC, video,
 *    soundtrack) → `header_image: null`. Daftar game TIDAK BOLEH ikut gagal
 *    hanya karena gambar tidak ada.
 *
 * 5. DI-CACHE CLOUDFLARE 24 JAM (cf.cacheTtl).
 *    Halaman yang sama tidak menembak Steam lagi, jadi harga satu kali
 *    permintaan pertama (±350 ms) dibayar sekali per hari per game.
 */

import {
	MAX_HEADER_IMAGE_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	STEAM_API_URL,
	STEAM_CC,
	STEAM_DETAIL_CACHE_TTL_S,
	STEAM_DETAIL_TIMEOUT_MS,
	STEAM_FETCH_CONCURRENCY,
	STEAM_FETCH_TIMEOUT_MS,
	STEAM_IMAGE_CACHE_TTL_S,
	STEAM_MAX_APP_ID,
} from "../config";

/**
 * appid Steam yang layak dikirim: bilangan bulat positif dalam rentang wajar.
 * Nilai lain (koma, spasi, teks dari metadata) langsung dilewati, jadi tidak
 * pernah ada subrequest yang jelas-jelas gagal.
 *
 * Menerima juga string angka ("620"), karena kolom `game_id` bisa terbaca
 * sebagai teks tergantung tipe kolomnya di database. Nilai baliknya SELALU
 * number, supaya kunci Map-nya sama saat dibaca kembali di rute.
 */
export function toSteamAppId(value: unknown): number | null {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0 || n > STEAM_MAX_APP_ID) return null;
	return n;
}

/**
 * Ambil `header_image` dari respons appdetails.
 *
 * Steam membalas `{ "620": { success: true, data: { header_image: "..." } } }`
 * dan `{ "620": { success: false } }` kalau appid tidak dikenal.
 *
 * URL dianggap sah HANYA kalau http(s); selain itu null, supaya nilai aneh
 * tidak ikut terkirim ke client untuk dipasang di <img src>.
 */
export function pickHeaderImage(payload: unknown, appId: number): string | null {
	if (!payload || typeof payload !== "object") return null;
	const entry = (payload as Record<string, any>)[String(appId)];
	if (!entry || entry.success !== true) return null;
	const image = entry.data?.header_image;
	if (typeof image !== "string") return null;
	const trimmed = image.trim();
	if (!trimmed || trimmed.length > MAX_HEADER_IMAGE_LENGTH) return null;
	if (!/^https?:\/\//i.test(trimmed)) return null;
	return trimmed;
}

/**
 * Jalankan `fn` untuk semua item dengan jumlah pekerjaan bersamaan dibatasi
 * `limit`. Dipakai supaya 25-100 game tidak menembak Steam sekaligus.
 *
 * Semua item ALWAYS menghasilkan nilai (index hasil sejajar index item), dan
 * `fn` diharapkan menangkap errornya sendiri — di sini tidak ada try/catch,
 * supaya satu kegagalan tidak membatalkan sisa daftar.
 */
export async function mapWithLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const out = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return out;
}

/** Ambil header_image satu appid. Selalu selesai: nilai balik null kalau gagal. */
export async function fetchHeaderImage(
	appId: number,
	fetcher: typeof fetch = fetch,
): Promise<string | null> {
	const url =
		`${STEAM_API_URL}?appids=${appId}` +
		`&cc=${STEAM_CC}` +
		`&l=en` +
		`&filters=basic`;

	try {
		const response = await fetcher(url, {
			headers: { accept: "application/json" },
			// Batas keras: 1 game yang lambat tidak boleh menahan seluruh respons.
			signal: AbortSignal.timeout(STEAM_FETCH_TIMEOUT_MS),
			// Simpan di cache tepi Cloudflare; halaman yang sama tidak menembak
			// Steam lagi selama TTL. Ini yang membuat panggilan berikutnya murah.
			cf: {
				cacheEverything: true,
				cacheTtl: STEAM_IMAGE_CACHE_TTL_S,
			},
		});
		if (!response.ok) return null;
		return pickHeaderImage(await response.json(), appId);
	} catch {
		// timeout / koneksi gagal / JSON rusak -> tanpa gambar, bukan error rute.
		return null;
	}
}

/**
 * Kumpulkan `game_id -> header_image` untuk satu halaman daftar game.
 *
 * appid dibuang duplikatnya lebih dulu (satu game bisa muncul lebih dari satu
 * baris kalau kelak JOIN-nya berubah) dan yang bukan angka wajar, jadi jumlah
 * subrequest selalu ≤ jumlah appid unik yang sah.
 */
export async function fetchHeaderImages(
	gameIds: readonly unknown[],
	fetcher: typeof fetch = fetch,
): Promise<Map<number, string>> {
	const unique: number[] = [];
	const seen = new Set<number>();
	for (const raw of gameIds) {
		const appId = toSteamAppId(raw);
		if (appId === null || seen.has(appId)) continue;
		seen.add(appId);
		unique.push(appId);
	}

	const images = await mapWithLimit(unique, STEAM_FETCH_CONCURRENCY, (appId) =>
		fetchHeaderImage(appId, fetcher),
	);

	const found = new Map<number, string>();
	unique.forEach((appId, index) => {
		const image = images[index];
		if (image) found.set(appId, image);
	});
	return found;
}

// ---------------------------------------------------------------------------
// DETAIL game — dipakai GET /api/games/:game_id
// ---------------------------------------------------------------------------
//
// Rute list cuma butuh `header_image` (filters=basic, ±2,3 KB). Rute detail
// butuh lebih banyak: deskripsi, requirements, kategori, genre, dan screenshots.
// Karena itu DI SINI `filters` TIDAK dipakai sama sekali — permintaannya persis
// seperti contoh di dokumentasi Steam:
//
//   https://store.steampowered.com/api/appdetails?appids=580
//
// ATURAN yang berlaku khusus jalur detail:
//
// 1. SATU game_id = SATU subrequest. Sama seperti jalur list; `game_id` di DB
//    dipakai langsung sebagai appid Steam, tanpa tabel pemetaan.
// 2. GAGAL = null, BUKAN error. Steam timeout/mati/ratelimit atau appid tidak
//    dikenal (`success: false`) → `fetchSteamDetail()` membalas null dan rute
//    yang memutuskan status HTTP-nya (404). Rute TIDAK boleh melempar dari sini.
// 3. DI-CACHE 24 JAM (cf.cacheTtl), sama seperti jalur list.
//
// Bentuk respons yang dikembalikan sengaja SAMA PERSIS dengan yang diminta
// client: name, detailed_description, short_description, pc_requirements,
// categories, genres, screenshots. Field lain dari Steam (movies, dlc, ratings,
// dll.) dibuang di sini, jadi tidak ikut membengkakkan respons Worker.

/** Nilai Steam yang layak dipasang di `<img src>`: teks http(s), panjang wajar. */
export function pickImageUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_IMAGE_URL_LENGTH) return null;
	if (!/^https?:\/\//i.test(trimmed)) return null;
	return trimmed;
}

/** Object -> array. Steam kadang mengirim `{}` (bukan array) atau null. */
function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Ubah `[{id, description}]` Steam jadi `[{id, description}]` yang bersih. */
function pickNamed(value: unknown): { id: string | number; description: string }[] {
	return asArray(value).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		const description =
			typeof item.description === "string" ? item.description.trim() : "";
		if (!description) return [];
		const id =
			typeof item.id === "string" || typeof item.id === "number" ? item.id : null;
		return id === null ? [] : [{ id, description }];
	});
}

/**
 * `pc_requirements` Steam bisa berbentuk objek (`{minimum, recommended}`),
 * string, atau array. Bentuk aslinya DIPERTAHANKAN utuh di sini selama masih
 * objek/array (client yang tahu cara merendernya); yang dibuang hanya bagian
 * yang tidak berguna — string kosong dan `{}` kosong.
 */
function pickRequirements(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.length > 0 ? value : null;
	if (typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(obj)) {
		if (typeof raw === "string") {
			if (raw.trim()) out[key] = raw;
		} else if (raw !== null && raw !== undefined) {
			out[key] = raw;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * `screenshots` Steam: `[{id, path_thumbnail, path_full}]`. Hanya URL yang lolos
 * `pickImageUrl()` yang ikut dikirim, dan satu screenshot tetap dikirim kalau
 * salah satu URL-nya ada (yang tidak ada bernilai null). `id` dibiarkan apa
 * adanya (Steam memakai angka; sebagian item bisa tidak punya id, jadi null
 * dipakai sebagai gantinya) supaya client tetap bisa memakainya sebagai kunci.
 */
function pickScreenshots(value: unknown): SteamScreenshot[] {
	return asArray(value).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		const thumbnail = pickImageUrl(item.path_thumbnail);
		const full = pickImageUrl(item.path_full);
		if (!thumbnail && !full) return [];
		const id = typeof item.id === "number" ? item.id : null;
		return [{ id, thumbnail, full }];
	});
}

/** Satu screenshot Steam, sudah dibersihkan. */
export interface SteamScreenshot {
	id: number | null;
	thumbnail: string | null;
	full: string | null;
}

/** Bentuk detail game yang dikirim ke client (lihat daftar field di atas). */
export interface SteamDetail {
	name: string | null;
	detailed_description: string | null;
	short_description: string | null;
	pc_requirements: unknown;
	categories: { id: string | number; description: string }[];
	genres: { id: string | number; description: string }[];
	screenshots: SteamScreenshot[];
}

/** Bersihkan isi `data` appdetails jadi bentuk yang dipakai client. */
export function shapeSteamDetail(data: Record<string, any>): SteamDetail {
	return {
		name: typeof data.name === "string" ? data.name : null,
		detailed_description:
			typeof data.detailed_description === "string"
				? data.detailed_description
				: null,
		short_description:
			typeof data.short_description === "string" ? data.short_description : null,
		pc_requirements: pickRequirements(data.pc_requirements),
		categories: pickNamed(data.categories),
		genres: pickNamed(data.genres),
		screenshots: pickScreenshots(data.screenshots),
	};
}

/**
 * Hasil pengambilan detail. Dipisah begini supaya rute bisa membalas status
 * yang jujur tanpa menebak-nebak:
 *   { ok: true, detail }                      -> 200
 *   { ok: false, reason: "unknown" }          -> 404 (Steam hidup, appid tak ada)
 *   { ok: false, reason: "unreachable" }      -> 502 (Steam balas non-200 / mati)
 */
export type SteamDetailResult =
	| { ok: true; detail: SteamDetail }
	| { ok: false; reason: "unknown" | "unreachable" };

/**
 * Ambil detail satu appid dari Steam Store.
 *
 * Selalu selesai (tidak melempar), jadi rute tidak perlu try/catch untuk
 * membalas JSON. `fetcher` bisa ditukar di tes (lihat test/units.spec.ts).
 */
export async function fetchSteamDetail(
	appId: number,
	fetcher: typeof fetch = fetch,
): Promise<SteamDetailResult> {
	if (toSteamAppId(appId) === null) return { ok: false, reason: "unknown" };

	// TANPA `filters=basic`: justru field lengkap itu yang dibutuhkan.
	const url = `${STEAM_API_URL}?appids=${appId}` + `&cc=${STEAM_CC}` + `&l=en`;

	try {
		const response = await fetcher(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(STEAM_DETAIL_TIMEOUT_MS),
			cf: {
				cacheEverything: true,
				cacheTtl: STEAM_DETAIL_CACHE_TTL_S,
			},
		});
		// 429/403/5xx: Steam tidak sanggup melayani -> bukan "appid tak dikenal".
		if (!response.ok) return { ok: false, reason: "unreachable" };

		const payload = (await response.json()) as Record<string, any>;
		const entry = payload?.[String(appId)];
		if (!entry || entry.success !== true) return { ok: false, reason: "unknown" };
		if (!entry.data || typeof entry.data !== "object") {
			return { ok: false, reason: "unknown" };
		}
		return { ok: true, detail: shapeSteamDetail(entry.data) };
	} catch {
		// timeout / koneksi gagal / JSON rusak -> unreachable, bukan error rute.
		return { ok: false, reason: "unreachable" };
	}
}
