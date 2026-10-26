import type postgres from "postgres";

// Bound each parameter to 32 KiB of ASCII hex, rather than a single large
// Bind message. Staging is connection-local and disappears at commit/rollback.
export const ASSET_HEX_CHUNK_SIZE = 32 * 1024;
export async function writeAssetLua(tx: postgres.TransactionSql, gameId: number, hex: string): Promise<void> {
	if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error("Invalid encrypted asset hex");
	if (hex.length <= ASSET_HEX_CHUNK_SIZE) {
		await tx`insert into game_assets (game_id, lua_data, encryption_version)
			values (${gameId}::bigint, decode(${hex}, 'hex'), 1)
			on conflict (game_id) do update set lua_data = excluded.lua_data, encryption_version = 1`;
		return;
	}
	await tx`create temporary table asset_lua_chunks (part integer primary key, hex_data text not null) on commit drop`;
	for (let offset = 0; offset < hex.length; offset += ASSET_HEX_CHUNK_SIZE) {
		const part = offset / ASSET_HEX_CHUNK_SIZE;
		await tx`insert into pg_temp.asset_lua_chunks (part, hex_data)
			values (${part}::integer, ${hex.slice(offset, offset + ASSET_HEX_CHUNK_SIZE)})`;
	}
	// Assemble on the server: only this final statement touches game_assets,
	// so its audit/reopen triggers fire once with the complete encrypted file.
	await tx`insert into game_assets (game_id, lua_data, encryption_version)
		select ${gameId}::bigint, decode(string_agg(hex_data, '' order by part), 'hex'), 1
		from pg_temp.asset_lua_chunks
		on conflict (game_id) do update set lua_data = excluded.lua_data, encryption_version = 1`;
}
