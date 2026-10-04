/**
 * POST /api/claim-invoice
 *
 * Klaim pembelian lewat nomor invoice. FE mengirim `invoice_number`, worker
 * mencocokkannya dengan tabel `history_purchase`, lalu membuat baris
 * `user_list_game` untuk user yang sedang bersesi:
 *
 *   - access_role_code = INVOICE_CLAIM_ROLE_CODE (4)
 *       -> app_id_buy = history_purchase.game_id (game yang dibeli)
 *       -> invoice tanpa game_id ditolak 422 (tidak ada yang bisa diisi)
 *   - access_role_code lain
 *       -> app_id_buy = 0
 *   - is_from_free_claim selalu false (kolom bool NOT NULL; "null" pada spek
 *     tidak mungkin tanpa ALTER skema — keputusan: isi false).
 *
 * Double claim diblok lewat kolom `history_purchase.is_invoice_used`:
 * null/false = belum dipakai, true = sudah. Penandaan + insert dilakukan di
 * SATU transaksi (sql.begin), jadi invoice tidak mungkin tercatat "dipakai"
 * tanpa baris user_list_game, atau sebaliknya. Dua permintaan serempak dengan
 * invoice sama: hanya satu yang menang UPDATE ... is not true; yang lain
 * dibalas 409.
 *
 * Identitas user DIAMBIL DARI SESI (requireSession), bukan dari body — FE
 * tidak pernah menentukan user_id-nya sendiri.
 */

import {
	INVOICE_CLAIM_ROLE_CODE,
	MAX_INVOICE_LENGTH,
	TABLE_HISTORY_PURCHASE,
	TABLE_USER_LIST_GAME,
} from "../config";
import { findUserById } from "../lib/auth-store";
import { readJsonBody, stringField } from "../lib/body";
import { fail, json } from "../lib/http";
import {
	preflightSession,
	requireSession,
	sessionFailStatus,
} from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

interface ClaimInput {
	invoiceNumber: string;
}

/** Satu baris `history_purchase` yang dibutuhkan rute ini. */
interface InvoiceRow {
	/** int8 -> driver mengembalikan string. */
	id: string;
	/** int4 -> number; null kalau invoice belum tertaut game. */
	game_id: number | null;
	/** Nullable bool: null/false = belum dipakai. */
	is_invoice_used: boolean | null;
}

export const claimInvoiceRoute: DbRoute<ClaimInput> = {
	method: "POST",
	path: "/api/claim-invoice",
	token: "none",
	requiresDb: true,

	prepare: async ({ request, env }) => {
		// Sesi diperiksa SEBELUM body dibaca: pemanggil tanpa sesi ditolak
		// lebih dulu, sama seperti rute auth lain (lihat preflightSession).
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);

		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const invoiceNumber = stringField(parsed.value, "invoice_number");
		if (!invoiceNumber) {
			return fail(400, "Field `invoice_number` wajib diisi.");
		}
		if (invoiceNumber.length > MAX_INVOICE_LENGTH) {
			return fail(
				400,
				`Invoice number terlalu panjang (maksimum ${MAX_INVOICE_LENGTH} karakter).`,
			);
		}

		return { input: { invoiceNumber } };
	},

	handle: async ({ request, env }, { invoiceNumber }, sql) => {
		const check = await requireSession(
			sql,
			env,
			request,
			request.headers.get("x-user-id"),
		);
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const userId = check.session.userId;

		// Role dibaca dari baris user di database, bukan dari FE.
		const user = await findUserById(sql, userId);
		if (!user) {
			return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");
		}

		// ---------------------------------------------------------------
		// Cari invoice. Pemeriksaan awal ini hanya untuk membedakan 404 vs
		// 409 dengan pesan yang jelas; keputusan final tetap di transaksi
		// di bawah (balapan antar permintaan dicegah di sana).
		// ---------------------------------------------------------------
		const invoiceRows = await sql<InvoiceRow[]>`
			select id, game_id, is_invoice_used
			from ${sql(TABLE_HISTORY_PURCHASE)}
			where invoice_number = ${invoiceNumber}
			limit 1
		`;
		const invoice = invoiceRows[0];
		if (!invoice) {
			return fail(404, "Invoice tidak ditemukan.", "INVOICE_TIDAK_ADA");
		}
		if (invoice.is_invoice_used === true) {
			return fail(
				409,
				"Invoice ini sudah pernah dipakai.",
				"INVOICE_SUDAH_DIPAKAI",
			);
		}

		// Role 4 butuh game_id; role lain memang sengaja diisi 0.
		const isRolePopulate = user.access_role_code === INVOICE_CLAIM_ROLE_CODE;
		if (isRolePopulate && invoice.game_id === null) {
			return fail(
				422,
				"Invoice ini tidak memuat game_id; tidak ada game yang bisa di-populate.",
				"INVOICE_TANPA_GAME",
			);
		}
		const appIdBuy = isRolePopulate ? Number(invoice.game_id) : 0;

		// ---------------------------------------------------------------
		// SATU transaksi: tandai invoice + insert baris kepemilikan.
		// `is not true` menangkap dua-duanya: false DAN null (kolom nullable).
		// Kalau insert gagal, seluruh transaksi mundur — penanda ikut batal.
		// ---------------------------------------------------------------
		const claimed = await sql.begin(async (tx) => {
			const marked = await tx`
				update ${sql(TABLE_HISTORY_PURCHASE)}
				set is_invoice_used = true, updated_at = now()
				where invoice_number = ${invoiceNumber}
					and is_invoice_used is not true
				returning id
			`;
			if (marked.length === 0) return null; // kalah balapan -> 409
			await tx`
				insert into ${sql(TABLE_USER_LIST_GAME)}
					(user_id, app_id_buy, is_from_free_claim, created_at, updated_at)
				values
					(${userId}::int8, ${appIdBuy}::int4, false, now(), now())
			`;
			return marked[0];
		});

		if (!claimed) {
			return fail(409, "Invoice ini sudah pernah dipakai.", "INVOICE_SUDAH_DIPAKAI");
		}

		return json({
			ok: true,
			user_id: userId,
			invoice_number: invoiceNumber,
			access_role_code: user.access_role_code,
			app_id_buy: appIdBuy,
			is_from_free_claim: false,
		});
	},
};
