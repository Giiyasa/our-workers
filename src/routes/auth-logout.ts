/**
 * POST /api/auth/logout
 *
 * Cabut sesi user. Setelah ini token yang masih tersimpan di komputer user
 * TIDAK BISA dipakai lagi — bukan sekadar "dihapus di layar", tapi benar-benar
 * ditolak server, karena catatan sesi di `user.machine_info` ikut dibuang.
 *
 * Ini alasan catatan sesi disimpan di kolom yang ada (lihat lib/session.ts):
 * tanpa tempat penyimpanan di server, token yang sudah beredar tetap sah
 * sampai masa berlakunya habis, dan "force logout" cuma kosmetik.
 *
 * `machine_info` yang dikirim FE tidak ikut terhapus — yang dibuang hanya
 * bagian "sesi".
 */

import { readMachineInfo, saveMachineInfoIf } from "../lib/auth-store";
import { fail, json } from "../lib/http";
import { withoutSession } from "../lib/session";
import { requireSession, preflightSession, sessionFailStatus } from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

export const authLogoutRoute: DbRoute<Record<string, never>> = {
	method: "POST",
	path: "/api/auth/logout",
	token: "none",
	requiresDb: true,
	prepare: ({ request, env }) => {
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		return { input: {} };
	},

	handle: async ({ request, env }, _input, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);

		// Bandingkan-lalu-tulis: jangan sampai menghapus perubahan yang dikirim
		// permintaan lain pada saat yang hampir bersamaan.
		let terhapus = false;
		for (let attempt = 0; attempt < 3 && !terhapus; attempt++) {
			const current = await readMachineInfo(sql, check.session.userId);
			terhapus = await saveMachineInfoIf(sql, check.session.userId, current, withoutSession(current));
		}
		if (!terhapus) {
			return fail(409, "Logout gagal karena ada perubahan bersamaan. Coba lagi.");
		}

		return json({ ok: true, status: "logout", user_id: check.session.userId });
	},
};
