import { STEAM_MAX_APP_ID, TABLE_GAME, TABLE_USER, TABLE_USER_LIST_GAME } from "../config";
import { readJsonBody } from "../lib/body";
import { fail, json } from "../lib/http";
import { fetchR2Lua } from "../lib/r2";
import { preflightSession, requireSession, sessionFailStatus } from "../lib/session-guard";
import { downloadAllowance, reserveDownload } from "../lib/download-limit";
import { readAssetJob, startAssetJob } from "../lib/asset-jobs";
import { AssetFailure } from "../lib/asset-providers";
import type { DbRoute } from "../lib/types";

export const claimGameRoute: DbRoute<{ gameId: number }> = {
	method: "POST", path: "/api/claim-game", token: "none", requiresDb: true,
	prepare: async ({ request, env }) => {
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;
		const raw = parsed.value.game_id;
		if (!(typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim())))) return fail(400, "Field game_id wajib berupa angka.");
		const gameId = Number(raw);
		if (!Number.isInteger(gameId) || gameId <= 0 || gameId > STEAM_MAX_APP_ID) return fail(400, "game_id di luar rentang AppID Steam.");
		return { input: { gameId } };
	},
	handle: async ({ request, env }, { gameId }, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const userId = check.session.userId;
		const users = await sql`select access_role_code, free_claim_game from ${sql(TABLE_USER)} where user_id = ${userId}::bigint`;
		const user = users[0];
		if (!user || ![2, 3, 4].includes(Number(user.access_role_code))) return fail(403, "Role akun tidak memiliki akses claim game.", "CLAIM_FORBIDDEN");
		if (!(await downloadAllowance(sql, userId))) return fail(429, "Batas 25 unduhan untuk sesi 12 jam ini sudah tercapai (50 per hari).", "DOWNLOAD_LIMIT");
		// Check eligibility before spending provider resources, then recheck inside the final transaction.
		if (Number(user.access_role_code) === 4) {
			const owned = await sql`select 1 from ${sql(TABLE_USER_LIST_GAME)} where user_id = ${userId}::bigint and app_id_buy = ${gameId}::bigint limit 1`;
			if (!owned.length && Number(user.free_claim_game) <= 0) return fail(403, "Kuota free claim habis. Klaim invoice untuk memiliki game ini.", "FREE_CLAIM_HABIS");
		}
		const games = await sql`select app_id, name, is_unavailable_game from ${sql(TABLE_GAME)} where app_id = ${gameId}::bigint limit 1`;
		if (!games[0]) return fail(404, "Game tidak ada di katalog.", "GAME_NOT_FOUND");
		if (games[0].is_unavailable_game === true) return fail(404, "Game belum tersedia.", "GAME_UNAVAILABLE");
		const job = await readAssetJob(sql, gameId);
		if (job?.status === "processing" && job.lease_live) return json({ ok: true, status: "processing", game_id: gameId, retry_after_seconds: 3 }, 202);
		let lua;
		try { lua = await fetchR2Lua(env, gameId, job?.status === "ready" ? job.r2_object_key ?? undefined : undefined); }
		catch { return fail(502, "Penyimpanan file sementara tidak dapat dihubungi.", "R2_UNAVAILABLE"); }
		if (!lua.ok) {
			if (lua.status !== 404) return fail(lua.status, lua.error, "R2_UNAVAILABLE");
			if ((job?.status === "failed" || job?.status === "not_found") && job.cooling) {
				return json({ ok: false, status: job.status, code: job.error_code, error: job.error_message, retry_after_seconds: job.retry_after_seconds }, job.status === "not_found" ? 404 : 503);
			}
			try { await startAssetJob(sql, env, gameId); }
			catch (error) { return fail(503, error instanceof AssetFailure ? error.message : "Persiapan asset gagal dimulai.", error instanceof AssetFailure ? error.code : "ASSET_START_FAILED"); }
			return json({ ok: true, status: "processing", game_id: gameId, retry_after_seconds: 3 }, 202);
		}
		const headers = new Headers({ "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${gameId}.lua"`, "x-game-id": String(gameId), "x-game-size": String(lua.bytes.length), "cache-control": "no-store" });
		if (games[0].name) headers.set("x-game-name", encodeURIComponent(games[0].name));
		// Construct response before committing counters, so header/response errors cannot burn a coupon.
		const response = new Response(lua.bytes as Uint8Array<ArrayBuffer>, { headers });
		class ClaimRejected extends Error { constructor(public code: string) { super(code); } }
		try {
			await sql.begin(async (tx) => {
				const current = await tx`select access_role_code, free_claim_game from ${sql(TABLE_USER)} where user_id = ${userId}::bigint for update`;
				const role = Number(current[0]?.access_role_code);
				if (![2, 3, 4].includes(role)) throw new ClaimRejected("CLAIM_FORBIDDEN");
				if (!(await reserveDownload(tx, userId))) throw new ClaimRejected("DOWNLOAD_LIMIT");
				if (role === 4) {
					const owned = await tx`select 1 from ${sql(TABLE_USER_LIST_GAME)} where user_id = ${userId}::bigint and app_id_buy = ${gameId}::bigint limit 1`;
					if (!owned.length) {
						if (Number(current[0]?.free_claim_game) <= 0) throw new ClaimRejected("FREE_CLAIM_HABIS");
						await tx`update ${sql(TABLE_USER)} set free_claim_game = free_claim_game - 1, updated_at = now() where user_id = ${userId}::bigint`;
						await tx`insert into ${sql(TABLE_USER_LIST_GAME)} (user_id, app_id_buy, is_from_free_claim) values (${userId}::bigint, ${gameId}::bigint, true)`;
					}
				}
			});
		} catch (error) {
			if (!(error instanceof ClaimRejected)) throw error;
			return fail(error.code === "DOWNLOAD_LIMIT" ? 429 : 403,
				error.code === "DOWNLOAD_LIMIT" ? "Batas 25 unduhan untuk sesi 12 jam ini sudah tercapai (50 per hari)." : error.code === "FREE_CLAIM_HABIS" ? "Kuota free claim habis." : "Role akun tidak memiliki akses claim game.", error.code);
		}
		return response;
	},
};
