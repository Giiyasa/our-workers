import { STEAM_MAX_APP_ID, TABLE_USER } from "../config";
import { readAssetJob } from "../lib/asset-jobs";
import { fail, json } from "../lib/http";
import { preflightSession, requireSession, sessionFailStatus } from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

export const claimStatusRoute: DbRoute<{ gameId: number }> = {
	method: "GET", path: "/api/claim/status/:app_id", pattern: /^\/api\/claim\/status\/(\d+)$/,
	token: "none", requiresDb: true,
	prepare: ({ request, env, params }) => {
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		const gameId = Number(params[0]);
		if (!Number.isInteger(gameId) || gameId <= 0 || gameId > STEAM_MAX_APP_ID) return fail(400, "AppID tidak valid.");
		return { input: { gameId } };
	},
	handle: async ({ request, env }, { gameId }, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const users = await sql`select access_role_code from ${sql(TABLE_USER)} where user_id = ${check.session.userId}::bigint`;
		if (![2, 3, 4].includes(Number(users[0]?.access_role_code))) return fail(403, "Akses claim tidak diizinkan.", "CLAIM_FORBIDDEN");
		const job = await readAssetJob(sql, gameId);
		const status = !job ? "idle" : job.status === "processing" && !job.lease_live ? "retry" : job.status;
		const response = json({ ok: true, game_id: gameId, status, code: job?.error_code ?? null,
			error: job?.error_message ?? null, retry_after_seconds: status === "processing" ? 3 : job?.retry_after_seconds ?? 0 });
		response.headers.set("cache-control", "no-store");
		return response;
	},
};
