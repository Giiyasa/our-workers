import type { Sql } from "./db";

/** Respect the deployed FK instead of assuming game_id is an AppID/internal ID. */
export async function invoiceGameReference(sql: Sql): Promise<"id" | "app_id"> {
	const rows = await sql`select a.attname as target_column from pg_constraint c
		join pg_attribute a on a.attrelid = c.confrelid and a.attnum = c.confkey[1]
		join pg_attribute source on source.attrelid = c.conrelid and source.attnum = c.conkey[1]
		where c.contype = 'f' and c.conrelid = 'public.history_purchase'::regclass
		and c.confrelid = 'public.game_lists'::regclass and source.attname = 'game_id'`;
	const column = rows[0]?.target_column;
	if (column !== "id" && column !== "app_id") throw new Error("Relasi game invoice tidak dikenali; periksa FK history_purchase.game_id.");
	return column;
}
