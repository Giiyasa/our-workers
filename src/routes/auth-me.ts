/**
 * GET /api/auth/me
 *
 * Siapa saya: profil user + sisa masa berlaku sesi.
 *
 * Dipakai aplikasi desktop saat dibuka kembali: kirim token yang tersimpan
 * (token utuh atau `session.token_hash` + `X-User-Id`), lalu:
 *
 *   200 -> sesi masih hidup; FE boleh lanjut tanpa meminta login
 *   401 -> sesi tidak sah / sudah kadaluarsa; FE memaksa login ulang
 *
 * Sisa masa berlaku dihitung dari jam DATABASE, bukan jam komputer user, dan
 * disertakan (`sesi.sisa_detik`) supaya FE bisa menampilkan hitung mundur.
 */

import { findUserById, readMachineInfo, shapeUser } from "../lib/auth-store";
import { fail, json } from "../lib/http";
import { readMachineParts } from "../lib/session";
import { requireSession, preflightSession, sessionFailStatus } from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

export const authMeRoute: DbRoute<Record<string, never>> = {
	method: "GET",
	path: "/api/auth/me",
	token: "none",
	requiresDb: true,
	prepare: ({ request, env }) => {
		// Diperiksa SEBELUM database dibuka (lihat preflightSession).
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		return { input: {} };
	},

	handle: async ({ request, env }, _input, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);

		const user = await findUserById(sql, check.session.userId);
		if (!user) return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");

		// `check.session.perangkat` adalah hasil perangkatSah() — catatan
		// pemulihan menang atas catatan login (lihat lib/session.ts).
		const perangkat = check.session.perangkat;
		// Bagian "mesin" (keterangan komputer kiriman FE) dibaca terpisah:
		// yang itu bukan urusan perangkat, dan tetap dilaporkan apa adanya.
		const parts = readMachineParts(await readMachineInfo(sql, check.session.userId));

		return json({
			ok: true,
			user: shapeUser(user),
			sesi: {
				mode: check.session.mode,
				exp: check.session.sesi.exp,
				expired_at: new Date(check.session.sesi.exp * 1000).toISOString(),
				dibuat_pada: new Date(check.session.sesi.iat * 1000).toISOString(),
				sisa_detik: check.session.sisaDetik,
			},
			// Keterangan perangkat yang SAH untuk akun ini. `sumber_perangkat`
			// dipakai layar Pengaturan untuk memberi tahu pengguna bahwa
			// komputer ini terdaftar lewat kode pemulihan, bukan lewat login.
			perangkat: perangkat
				? {
						device_id: perangkat.device_id,
						device_name: perangkat.device_name,
						terdaftar_pada: perangkat.terdaftar_pada
							? new Date(perangkat.terdaftar_pada * 1000).toISOString()
							: null,
						terakhir_masuk: perangkat.terakhir_masuk
							? new Date(perangkat.terakhir_masuk * 1000).toISOString()
							: null,
					}
				: null,
			sumber_perangkat: check.session.sumberPerangkat,
			// Bagian "mesin" apa adanya; null kalau FE belum pernah mengirimnya.
			machine_info: parts.mesin,
		});
	},
};
