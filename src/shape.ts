/**
 * Bentuk JSON yang dikirim ke client.
 *
 * Hasil LEFT JOIN yang datar (kolom game_* dan asset_* sejajar) dirapikan jadi
 * bersarang: { ...game, asset: { has_asset, ... } }.
 */

/** Baca kolom text sebagai JSON; kembalikan null kalau isinya bukan JSON. */
function tryParseJson(text: unknown): unknown {
	if (typeof text !== "string" || !text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * `asset.has_asset` berasal dari asset_game_id: kalau game belum punya asset
 * sama sekali, kolom asset yang lain pasti null semua.
 *
 * `headerImage` diambil terpisah dari Steam (lihat lib/steam.ts) dan bukan
 * bagian dari hasil JOIN. Nilai bawaan `null` supaya pemanggil yang tidak
 * butuh gambar tetap bisa memakai fungsi ini apa adanya.
 *
 * Sekarang hanya GET /api/games yang memakainya — GET /api/games/:game_id
 * mengambil datanya dari Steam Store, bukan dari join ini.
 */
export function shapeGame(
	row: Record<string, any>,
	full: boolean,
	headerImage: string | null = null,
) {
	const hasAsset = row.asset_game_id !== null && row.asset_game_id !== undefined;

	const asset: Record<string, unknown> = {
		has_asset: hasAsset,
		created_at: row.asset_created_at ?? null,
		updated_at: row.asset_updated_at ?? null,
	};

	if (full) {
		asset.lua_data = row.asset_lua_data ?? null;
		asset.metadata = row.asset_metadata ?? null;
		// Bentuk JSON dari metadata, biar client tidak perlu parse sendiri.
		asset.metadata_json = tryParseJson(row.asset_metadata);
		asset.encyription = row.asset_encyription ?? null;
	} else {
		asset.lua_bytes = row.asset_lua_bytes ?? null;
		asset.metadata_bytes = row.asset_metadata_bytes ?? null;
		asset.encyription_bytes = row.asset_ency_bytes ?? null;
	}

	return {
		id: row.id,
		game_id: row.game_id,
		game_name: row.game_name,
		description: row.description ?? null,
		category: row.category ?? null,
		genre: row.genre ?? null,
		tags: row.tags ?? null,
		// URL gambar header dari Steam Store. null kalau Steam tidak menjawab.
		header_image: headerImage,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		asset,
	};
}
