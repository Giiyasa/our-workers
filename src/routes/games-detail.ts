/**
 * GET /api/games/:game_id — satu game + asset penuh
 * (lua_data, metadata, encyription).
 *
 * Tidak butuh token. `game_id` harus angka murni; id yang bukan angka ditolak
 * 400 SEBELUM koneksi DB dibuka.
 */

import { TABLE_ASSET, TABLE_GAME } from "../config";
import { fail, json } from "../lib/http";
import { shapeGame } from "../shape";
import type { DbRoute } from "../lib/types";

interface Input {
	gameId: number;
}

export const gamesDetailRoute: DbRoute<Input> = {
	method: "GET",
	path: "/api/games/:game_id",
	pattern: /^\/api\/games\/([^/]+)$/,
	token: "none",
	requiresDb: true,
	prepare: ({ params }) => {
		const rawId = params[0] ?? "";
		if (!/^\d{1,15}$/.test(rawId)) {
			return fail(400, "game_id harus berupa angka.");
		}
		return { input: { gameId: Number(rawId) } };
	},
	handle: async ({}, { gameId }, sql) => {
		const rows = await sql`
			select
				g.id, g.game_id, g.game_name, g.description, g.category,
				g.genre, g.tags, g.created_at, g.updated_at,
				a.game_id as asset_game_id,
				a.created_at as asset_created_at,
				a.updated_at as asset_updated_at,
				a.lua_data as asset_lua_data,
				a.metadata as asset_metadata,
				a.encyription as asset_encyription
			from ${sql(TABLE_GAME)} g
			left join ${sql(TABLE_ASSET)} a on a.game_id = g.game_id
			where g.game_id = ${gameId}
			limit 1
		`;

		if (rows.length === 0) {
			return fail(404, `game_id ${gameId} tidak ditemukan.`);
		}
		return json({ ok: true, data: shapeGame(rows[0], true) });
	},
};
