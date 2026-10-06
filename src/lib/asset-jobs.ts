import { createDb, type Sql } from "./db";
import { encryptAsset, decryptAsset } from "./asset-crypto";
import { AssetFailure, fetchProviderLua, readLua } from "./asset-providers";
import { uploadR2Lua } from "./r2";

export interface AssetMessage { gameId: number; requestToken: string }
export async function readAssetJob(sql: Sql, gameId: number) {
	const rows = await sql`select status, r2_object_key, error_code, error_message,
		lease_expires_at > now() as lease_live,
		coalesce(next_retry_at > now(), false) as cooling,
		greatest(0, ceil(extract(epoch from next_retry_at - now())))::int as retry_after_seconds
		from game_asset_jobs where game_id = ${gameId}::bigint`;
	return rows[0];
}

export async function startAssetJob(sql: Sql, env: Env, gameId: number): Promise<void> {
	if (!env.ASSET_QUEUE) throw new AssetFailure("QUEUE_CONFIG", "Antrean asset belum dikonfigurasi.");
	if (!env.ASSET_MASTER_KEY_HEX || !/^[a-f\d]{64}$/i.test(env.ASSET_MASTER_KEY_HEX)) throw new AssetFailure("ASSET_CONFIG", "Master key asset belum dikonfigurasi.");
	const token = crypto.randomUUID();
	const acquired = await sql`
		insert into game_asset_jobs (game_id, status, lease_token, request_token, lease_expires_at, attempts)
		values (${gameId}::bigint, 'processing', ${token}::uuid, ${token}::uuid, now() + interval '5 minutes', 1)
		on conflict (game_id) do update set status = 'processing', lease_token = excluded.lease_token,
			request_token = excluded.request_token, lease_expires_at = excluded.lease_expires_at,
			work_started_at = null, next_retry_at = null, error_code = null, error_message = null,
			attempts = game_asset_jobs.attempts + 1, updated_at = now()
		where (game_asset_jobs.status = 'processing' and game_asset_jobs.lease_expires_at <= now())
			or (game_asset_jobs.status <> 'processing' and (game_asset_jobs.next_retry_at is null or game_asset_jobs.next_retry_at <= now()))
		returning game_id
	`;
	if (!acquired.length) return;
	try { await env.ASSET_QUEUE.send({ gameId, requestToken: token }); }
	catch {
		await sql`update game_asset_jobs set status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
			error_message = 'Antrean asset sementara tidak tersedia.', next_retry_at = now() + interval '60 seconds',
			lease_token = null, lease_expires_at = null, updated_at = now()
			where game_id = ${gameId}::bigint and request_token = ${token}::uuid and work_started_at is null`;
		throw new AssetFailure("QUEUE_UNAVAILABLE", "Antrean asset sementara tidak tersedia.");
	}
}

export async function consumeAssetJob(message: AssetMessage, env: Env): Promise<"done" | "busy"> {
	const sql = createDb(env);
	const token = crypto.randomUUID();
	try {
		const owned = await sql`update game_asset_jobs set lease_token = ${token}::uuid,
			lease_expires_at = now() + interval '5 minutes', work_started_at = now(), updated_at = now()
			where game_id = ${message.gameId}::bigint and request_token = ${message.requestToken}::uuid
			and status = 'processing' and (work_started_at is null or lease_expires_at <= now()) returning game_id`;
		if (!owned.length) {
			const current = await sql`select status from game_asset_jobs where game_id = ${message.gameId}::bigint
				and request_token = ${message.requestToken}::uuid`;
			return current[0]?.status === "processing" ? "busy" : "done";
		}
		let stage = "database_read";
		try {
			let bytes: Uint8Array | undefined;
			let source = "database";
			const existing = await sql`select encode(lua_data, 'hex') as lua_hex from game_assets where game_id = ${message.gameId}::bigint`;
			if (existing[0]?.lua_hex) {
				try {
					const restored = await decryptAsset(existing[0].lua_hex, env.ASSET_MASTER_KEY_HEX);
					bytes = await readLua(new Response(restored as Uint8Array<ArrayBuffer>));
				} catch { /* Invalid/unsupported asset needs provider fallback. */ }
			}
			if (!bytes) {
				stage = "provider_fetch";
				const found = await fetchProviderLua(sql, env, message.gameId);
				bytes = found.bytes; source = found.source;
			}
			stage = "encrypt";
			const blob = await encryptAsset(bytes, env.ASSET_MASTER_KEY_HEX);
			const objectKey = `lua/${message.gameId}/${token}.lua`;
			// Upload is immutable per lease; stale consumers cannot overwrite the current file.
			stage = "r2_upload";
			await uploadR2Lua(env, objectKey, bytes);
			stage = "database_publish";
			await sql.begin(async (tx) => {
				const locked = await tx`select game_id from game_asset_jobs where game_id = ${message.gameId}::bigint
					and lease_token = ${token}::uuid and status = 'processing' and lease_expires_at > now() for update`;
				if (!locked.length) return;
				const hex = Array.from(blob, (byte) => byte.toString(16).padStart(2, "0")).join("");
				await tx`insert into game_assets (game_id, lua_data, encryption_version)
					values (${message.gameId}::bigint, decode(${hex}, 'hex'), 1)
					on conflict (game_id) do update set lua_data = excluded.lua_data, encryption_version = 1`;
				await tx`update game_asset_jobs set status = 'ready', r2_object_key = ${objectKey}, last_provider = ${source},
					error_code = null, error_message = null, next_retry_at = null,
					lease_token = null, lease_expires_at = null, updated_at = now() where game_id = ${message.gameId}::bigint`;
			});
		} catch (error) {
			const known = error instanceof AssetFailure;
			const rawCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			console.error("asset_job_failed", {
				appId: message.gameId, stage,
				code: known ? error.code : /^[A-Z0-9]{5}$/.test(rawCode) ? rawCode : "ASSET_FETCH_FAILED",
				reason: error instanceof TypeError ? "type_or_network_error" : "job_error",
			});
			await sql`update game_asset_jobs set status = ${known && error.code === "ASSET_NOT_FOUND" ? "not_found" : "failed"},
				error_code = ${known ? error.code : "ASSET_FETCH_FAILED"},
				error_message = ${known ? error.message : "Persiapan asset gagal. Coba lagi nanti."},
				next_retry_at = now() + ${known ? error.retrySeconds : 60} * interval '1 second',
				lease_token = null, lease_expires_at = null, updated_at = now()
				where game_id = ${message.gameId}::bigint and lease_token = ${token}::uuid and status = 'processing'`;
		}
		return "done";
	} finally { await sql.end({ timeout: 5 }); }
}
