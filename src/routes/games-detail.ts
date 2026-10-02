/**
 * GET /api/games/:game_id — detail satu game.
 *
 * SUMBER DATA: Steam Store (appdetails), BUKAN database. `game_id` dari jalur
 * dipakai LANGSUNG sebagai appid Steam, jadi permintaan ke Steam-nya sama
 * persis dengan contoh di dokumentasi:
 *
 *   https://store.steampowered.com/api/appdetails?appids=578080
 *
 * Hanya parameter `game_id`. Yang dikirim balik ke client cuma tujuh field ini
 * (nama field JSON-nya persis seperti yang diminta):
 *
 *   name, detailed_description, short_description, pc_requirements,
 *   categories, genres, screenshots
 *
 * Field lain dari Steam (movies, dlc, ratings, achievements, harga, ...)
 * dibuang di `shapeSteamDetail()` — lihat src/lib/steam.ts. Rinciannya:
 *
 *   categories  -> [{ id, description }]
 *   genres      -> [{ id, description }]
 *   screenshots -> [{ id, thumbnail, full }]
 *   pc_requirements -> bentuk asli Steam apa adanya ({ minimum, recommended }),
 *                      atau null kalau game tidak mencantumkannya
 *
 * Bentuk balasan (200):
 *   { "ok": true, "data": { name, detailed_description, short_description,
 *     pc_requirements, categories, genres, screenshots } }
 *
 * FIELD YANG TIDAK ADA TETAP DIKIRIM sebagai `null`/`[]`, jadi bentuk responsnya
 * selalu sama dan client tidak perlu menebak apakah field-nya hilang.
 *
 * TANPA TOKEN dan TANPA syarat "harus ada di database": `game_id` yang sah di
 * Steam tetapi belum ada di `game_list` tetap dibalas 200.
 * `requiresDb: false` berarti rute ini tidak pernah membuka koneksi Postgres.
 *
 * STATUS:
 *   200 — Steam mengenali appid itu
 *   400 — `game_id` bukan angka murni / di luar rentang appid (ditolak di
 *         prepare(), jadi permintaan ngawur tidak pernah menembak Steam)
 *   404 — Steam hidup, tapi appid itu tidak ada di Steam Store
 *   502 — Steam tidak bisa dihubungi (timeout, mati, 429/5xx)
 */

import { STEAM_MAX_APP_ID } from "../config";
import { fail, json } from "../lib/http";
import { fetchSteamDetail } from "../lib/steam";
import type { PlainRoute } from "../lib/types";

interface Input {
	gameId: number;
}

export const gamesDetailRoute: PlainRoute<Input> = {
	method: "GET",
	path: "/api/games/:game_id",
	pattern: /^\/api\/games\/([^/]+)$/,
	token: "none",
	requiresDb: false,
	prepare: ({ params }) => {
		const rawId = params[0] ?? "";
		// Angka murni saja: "620abc" atau "62 0" ditolak di sini, sebelum ke Steam.
		if (!/^\d{1,15}$/.test(rawId)) {
			return fail(400, "game_id harus berupa angka.");
		}
		const gameId = Number(rawId);
		// 15 digit selalu di bawah Number.MAX_SAFE_INTEGER, jadi konversinya aman.
		if (gameId <= 0 || gameId > STEAM_MAX_APP_ID) {
			return fail(400, `game_id ${rawId} di luar rentang appid Steam.`);
		}
		return { input: { gameId } };
	},
	handle: async ({}, { gameId }) => {
		const result = await fetchSteamDetail(gameId);

		if (result.ok) {
			return json({ ok: true, data: result.detail });
		}

		// Dua kegagalan dibedakan supaya pesannya jujur: appid tidak ada (404)
		// vs Steam yang tidak menjawab (502). Client bisa menampilkan pesan yang
		// berbeda, dan operator tahu mana yang perlu ditengok.
		if (result.reason === "unknown") {
			return fail(404, `game_id ${gameId} tidak ada di Steam Store.`);
		}
		return fail(502, `Steam tidak bisa dihubungi untuk game_id ${gameId}.`);
	},
};
