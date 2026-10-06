import { MAX_INVOICE_LENGTH } from "../config";
import { readJsonBody, stringField } from "../lib/body";
import { fail, json } from "../lib/http";
import { invoiceGameReference } from "../lib/invoice-game";
import { preflightSession, requireSession, sessionFailStatus } from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

export const claimInvoiceRoute: DbRoute<{ invoiceNumber: string }> = {
	method: "POST", path: "/api/claim-invoice", token: "none", requiresDb: true,
	prepare: async ({ request, env }) => {
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;
		const invoiceNumber = stringField(parsed.value, "invoice_number");
		if (!invoiceNumber || invoiceNumber.length > MAX_INVOICE_LENGTH) return fail(400, "Field invoice_number wajib diisi, maksimum 64 karakter.");
		return { input: { invoiceNumber } };
	},
	handle: async ({ request, env }, { invoiceNumber }, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const userId = check.session.userId;
		const reference = await invoiceGameReference(sql);
		return await sql.begin(async (tx) => {
			// Same lock order as free claim; invoice/free-claim races cannot duplicate ownership.
			const users = await tx`select access_role_code from public."user" where user_id = ${userId}::bigint for update`;
			const role = Number(users[0]?.access_role_code);
			if (![2, 3, 4].includes(role)) return fail(403, "Role akun tidak memiliki akses claim invoice.", "CLAIM_FORBIDDEN");
			const invoices = await tx`select id, game_id, user_id, is_invoice_used from history_purchase where invoice_number = ${invoiceNumber} for update`;
			const invoice = invoices[0];
			if (!invoice) return fail(404, "Invoice tidak ditemukan.", "INVOICE_TIDAK_ADA");
			if (invoice.user_id != null && String(invoice.user_id) !== userId) return fail(403, "Invoice ini bukan milik akun ini.", "INVOICE_FORBIDDEN");
			if (invoice.is_invoice_used) return fail(409, "Invoice ini sudah pernah dipakai.", "INVOICE_SUDAH_DIPAKAI");
			let appIdBuy = 0;
			let nameGame: string | null = null;
			if (role === 4) {
				if (invoice.game_id == null) return fail(422, "Invoice tidak memuat game.", "INVOICE_TANPA_GAME");
				const games = await tx`select app_id, name from game_lists where ${tx(reference)} = ${invoice.game_id}::bigint limit 1`;
				if (!games[0]) return fail(422, "Game invoice tidak ditemukan di katalog.", "INVOICE_TANPA_GAME");
				appIdBuy = Number(games[0].app_id); nameGame = games[0].name;
				const owned = await tx`select id, purchase_id from user_list_game where user_id = ${userId}::bigint and app_id_buy = ${appIdBuy}::bigint order by id limit 1`;
				if (!owned[0]) {
					await tx`insert into user_list_game (user_id, app_id_buy, is_from_free_claim, purchase_id)
						values (${userId}::bigint, ${appIdBuy}::bigint, false, ${invoice.id}::bigint)`;
				} else if (owned[0].purchase_id == null) {
					await tx`update user_list_game set purchase_id = ${invoice.id}::bigint, updated_at = now() where id = ${owned[0].id}::bigint`;
				}
			}
			// Roles 2/3 do not create a fictitious AppID=0 library entry (invalid with the latest FK).
			await tx`update history_purchase set user_id = ${userId}::bigint, is_invoice_used = true, updated_at = now() where id = ${invoice.id}::bigint`;
			return json({ ok: true, user_id: userId, invoice_number: invoiceNumber, name_game: nameGame,
				access_role_code: role, app_id_buy: appIdBuy, is_from_free_claim: false });
		});
	},
};
