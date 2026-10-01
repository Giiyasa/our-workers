/**
 * GET /api/db/inspect?table=game_list|game_asset
 *
 * Diagnosa: daftar kolom sebuah tabel, tanpa membuka dashboard. Hanya tabel
 * yang ada di ALLOWED_TABLES yang boleh dibaca — permintaan ke tabel lain
 * (mis. `user`) ditolak sebelum koneksi DB dibuka.
 *
 * Butuh write token.
 */

import { ALLOWED_TABLES, TABLE_GAME } from "../config";
import { fail, json } from "../lib/http";
import type { DbRoute } from "../lib/types";

interface Input {
	table: string;
}

export const inspectRoute: DbRoute<Input> = {
	method: "GET",
	path: "/api/db/inspect",
	token: "write",
	requiresDb: true,
	prepare: ({ url }) => {
		const table = url.searchParams.get("table") ?? TABLE_GAME;
		if (!ALLOWED_TABLES.has(table)) {
			return fail(
				400,
				`Tabel tidak diizinkan. Pilihan: ${[...ALLOWED_TABLES].join(", ")}`,
			);
		}
		return { input: { table } };
	},
	handle: async ({}, { table }, sql) => {
		const columns = await sql`
			select column_name, data_type, is_nullable, column_default
			from information_schema.columns
			where table_name = ${table}
			order by ordinal_position
		`;
		const exists = await sql`
			select to_regclass(${`public.${table}`}) is not null as table_exists
		`;
		return json({
			ok: true,
			table,
			exists: exists[0]?.table_exists ?? false,
			columns,
		});
	},
};
