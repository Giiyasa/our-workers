/**
 * POST /api/auth/machine
 *
 * Simpan keterangan komputer user (dikirim FE setelah login) ke kolom
 * `user.machine_info`.
 *
 * Butuh sesi yang sah: kirim `X-Access-Token` (token utuh ATAU
 * `session.token_hash` + `X-User-Id`).
 *
 * ============================================================================
 * SATU KOLOM, DUA PEMILIK
 * ============================================================================
 * `machine_info` dipakai bersama oleh Worker (catatan sesi: masa berlaku token)
 * dan oleh FE (keterangan komputer). Karena itu penulisannya TIDAK menimpa
 * kolom mentah-mentah, melainkan:
 *
 *   baca isi kolom -> sisipkan bagian "mesin" -> tulis kembali
 *
 * dengan pola bandingkan-lalu-tulis supaya tidak menghapus catatan sesi kalau
 * ada dua permintaan yang datang hampir bersamaan. Bentuk isinya dijelaskan di
 * lib/session.ts.
 */

import { MAX_MACHINE_INFO_LENGTH } from "../config";
import { readMachineInfo, saveMachineInfoIf } from "../lib/auth-store";
import { rawField, readJsonBody } from "../lib/body";
import { fail, json } from "../lib/http";
import { machineInfoFits, withMachineInfo } from "../lib/session";
import { requireSession, preflightSession, sessionFailStatus } from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

interface Input {
	/** Keterangan komputer, apa adanya (teks atau JSON). */
	machineInfo: string;
}

export const authMachineRoute: DbRoute<Input> = {
	method: "POST",
	path: "/api/auth/machine",
	token: "none",
	requiresDb: true,
	prepare: async ({ request, env }) => {
		// Pemeriksaan bentuk/tanda tangan token SELESAI sebelum database
		// dibuka; catatan sesi dicocokkan belakangan di handle().
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);

		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		// Diterima dengan nama `machine_info` (sesuai istilah FE/DB); nilai apa
		// pun diterima apa adanya, termasuk objek JSON.
		const machineInfo = rawField(parsed.value, "machine_info") || rawField(parsed.value, "machineInfo");
		if (!machineInfo.trim()) {
			return fail(400, "Field `machine_info` wajib diisi.");
		}
		if (machineInfo.length > MAX_MACHINE_INFO_LENGTH * 2) {
			return fail(413, `Field \`machine_info\` terlalu besar (maksimum ${MAX_MACHINE_INFO_LENGTH} byte).`);
		}
		return { input: { machineInfo } };
	},

	handle: async ({ request, env }, { machineInfo }, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);

		// `machine_info` dikirim sebagai teks; kalau FE mengirim objek, `rawField`
		// sudah mengubahnya jadi teks JSON. Objek itu lalu diurai supaya
		// tersimpan sebagai bagian "mesin", bukan sebagai teks bersarang.
		const nilaiMesin = uraiMesin(machineInfo);

		let tersimpan = false;
		for (let attempt = 0; attempt < 3 && !tersimpan; attempt++) {
			const current = await readMachineInfo(sql, check.session.userId);
			const next = withMachineInfo(current, nilaiMesin);
			if (!machineInfoFits(next)) {
				return fail(413, `Keterangan komputer terlalu besar (maksimum ${MAX_MACHINE_INFO_LENGTH} byte).`);
			}
			tersimpan = await saveMachineInfoIf(sql, check.session.userId, current, next);
		}
		if (!tersimpan) {
			return fail(409, "Data komputer gagal disimpan karena ada perubahan bersamaan. Coba lagi.");
		}

		return json({
			ok: true,
			user_id: check.session.userId,
			machine_info_terpasang: true,
			// Sesi ikut dilaporkan supaya FE bisa memastikan catatan sesinya
			// masih utuh setelah penulisan ini.
			sesi_sisa_detik: check.session.sisaDetik,
			mode_sesi: check.session.mode,
		});
	},
};

/** Terima objek JSON sebagai nilai apa adanya; teks biasa dikembalikan apa adanya. */
function uraiMesin(raw: string): unknown {
	const text = raw.trim();
	if (!text.startsWith("{") && !text.startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
