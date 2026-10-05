/**
 * POST /api/claim-game — klaim + unduh file .lua untuk satu game.
 *
 * Alur yang diminta:
 *   1. Cek hak klaim berdasar access_role_code:
 *        - Role INVOICE_CLAIM_ROLE_CODE (4):
 *            a. Sudah punya game itu di `user_list_game` (hasil klaim invoice
 *               app_id_buy = game_id, maupun free claim sebelumnya)
 *               -> RE-DOWNLOAD: file dikirim lagi, kupon tidak tersentuh,
 *                  tidak ada baris baru.
 *            b. Belum punya -> pakai kupon `user.free_claim_game`:
 *               dikurangi 1 + baris `user_list_game` (is_from_free_claim = true)
 *               dibuat dalam SATU transaksi. Kupon habis -> 403.
 *        - Role lain: bebas mengklaim game mana pun -> langsung unduh file,
 *          database TIDAK ditulis (keputusan: hanya undahan file, bukan
 *          pencatatan kepemilikan).
 *   2. File diambil dari bucket R2 (`lua/<game_id>.lua`, plaintext .lua) —
 *      lihat lib/r2.ts untuk alasan kredensial berbentuk secret, bukan binding.
 *   3. Client menyimpan filenya sendiri; worker balas biner
 *      application/octet-stream + Content-Disposition `<game_id>.lua`
 *      + metadata lewat header X-Game-* (nama game di-encode URL).
 *
 * URUTAN PENTING: R2 ditembus SEBELUM transaksi kupon. Kalau file belum
 * ada di bucket (`lua/3586820.lua` per 2026-10-05), kupon TIDAK boleh
 * terbakar — user diberi 404 dan boleh mencoba lagi setelah file diunggah.
 *
 * STATUS:
 *   200 file .lua · 400 body salah · 401 sesi tidak sah ·
 *   403 kupon free claim habis · 404 game tidak ada / file belum diunggah ·
 *   409 kalah balapan dua klaim serempak · 503 R2 kredensial belum dipasang ·
 *   502 R2/Steam tidak bisa dihubungi.
 */

import {
	INVOICE_CLAIM_ROLE_CODE,
	STEAM_MAX_APP_ID,
	TABLE_GAME,
	TABLE_USER,
	TABLE_USER_LIST_GAME,
} from "../config";
import { findUserById } from "../lib/auth-store";
import { readJsonBody } from "../lib/body";
import { fail } from "../lib/http";
import { fetchR2Lua } from "../lib/r2";
import {
	preflightSession,
	requireSession,
	sessionFailStatus,
} from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

interface ClaimInput {
	gameId: number;
}

/** Satu baris `game_lists` yang dibutuhkan rute ini. */
interface GameRow {
	/** int4 -> number; Steam App ID. */
	app_id: number;
	name: string | null;
}

/** Baris penanda "sudah punya" dari `user_list_game`. */
interface OwnedRow {
	/** int8 -> string; hanya dibutuhkan bentuknya, bukan nilainya. */
	user_id: string;
	is_from_free_claim: boolean | null;
}

export const claimGameRoute: DbRoute<ClaimInput> = {
	method: "POST",
	path: "/api/claim-game",
	token: "none",
	requiresDb: true,

	prepare: async ({ request, env }) => {
		// Sesi diperiksa bentuk + tanda tangannya SEBELUM body/DB — pola sama
		// dengan route-session lain (claim-invoice).
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);

		const parsed = await readJsonBody(request);
		if (parsed instanceof Response) return parsed;

		const raw = parsed.value.game_id;
		// Terima dua bentuk: number dari JSON, atau string angka murni —
		// "62abc" / "6 2" / "" ditolak. Bentuk diperketat SEBELUM koneksi DB.
		const isNumeric =
			typeof raw === "number" ||
			(typeof raw === "string" && /^\d+$/.test(raw.trim()));
		if (!isNumeric) {
			return fail(400, "Field `game_id` wajib berupa angka.");
		}
		const gameId = Number(typeof raw === "string" ? raw.trim() : raw);
		if (!Number.isInteger(gameId) || gameId <= 0 || gameId > STEAM_MAX_APP_ID) {
			return fail(400, `game_id ${String(raw)} di luar rentang appid Steam.`);
		}

		return { input: { gameId } };
	},

	handle: async ({ request, env }, { gameId }, sql) => {
		const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const userId = check.session.userId;

		// Role dibaca dari baris user di database, bukan dari FE (pola sama
		// dengan claim-invoice).
		const user = await findUserById(sql, userId);
		if (!user) {
			return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");
		}

		// ------------------------------------------------------------------
		// Tahap pencarian game + file R2 (SEBELUM transaksi kupon):
		//   - Role 4 yang BELUM punya game: file yang tidak ada jangan
		//     membakar kupon -> urutan ini yang menjamin itu.
		//   - Role lain / sudah punya: tahap tulis ke database dilewati
		//     total, jadi pencarian game murni untuk metadata (X-Game-Name)
		//     dan boleh gagal dengan aman (nama game = null di header).
		// ------------------------------------------------------------------
		const gameRows: GameRow[] = await sql<GameRow[]>`
			select app_id, name
			from ${sql(TABLE_GAME)}
			where app_id = ${gameId}::int4
			limit 1
		`;
		const game = gameRows[0];

		const lua = await fetchR2Lua(env, gameId);
		if (!lua.ok) {
			// R2 belum dipasang (503) / file belum diunggah (404) / R2 mati (502).
			// Transaksi kupon belum dibuka — tidak ada yang terbakar.
			return fail(lua.status, lua.error);
		}

		// ------------------------------------------------------------------
		// Role 4: cek kepemilikan lalu (bila perlu) konsumsi kupon.
		// ------------------------------------------------------------------
		if (user.access_role_code === INVOICE_CLAIM_ROLE_CODE) {
			const ownedRows: OwnedRow[] = await sql<OwnedRow[]>`
				select user_id, is_from_free_claim
				from ${sql(TABLE_USER_LIST_GAME)}
				where user_id = ${userId}::int8
					and app_id_buy = ${gameId}::int4
				limit 1
			`;
			const alreadyOwned = ownedRows.length > 0;

			if (!alreadyOwned) {
				// SATU transaksi: deadlock dua klik serempak dicegah dengan
				// FOR UPDATE di baris user (pemilik kupon). Tanpa itu, dua
				// transaksi bisa sama-sama membaca sisa kupon 1 lalu dua-duanya
				// mengurangi — saldo minus dan satu baris kepemilikan bayangan.
				const claimed = await sql.begin(async (tx) => {
					const userRows = await tx`
						select free_claim_game
						from ${sql(TABLE_USER)}
						where user_id = ${userId}::int8
						for update
					`;
					const remaining = Number(userRows[0]?.free_claim_game ?? 0);

					// Cek ulang kepemilikan di DALAM transaksi: kemenangan
					// balapan dengan klaim serempak diputuskan di sini —
					// DB-serialisasi, bukan asumsi read-earlier.
					const stillOwned = await tx`
						select 1 from ${sql(TABLE_USER_LIST_GAME)}
						where user_id = ${userId}::int8 and app_id_buy = ${gameId}::int4
						limit 1
					`;
					if (stillOwned.length > 0) {
						return { status: "punya" as const };
					}
					if (remaining <= 0) {
						return { status: "habis" as const };
					}

					await tx`
						update ${sql(TABLE_USER)}
						set free_claim_game = free_claim_game - 1, updated_at = now()
						where user_id = ${userId}::int8
					`;
					await tx`
						insert into ${sql(TABLE_USER_LIST_GAME)}
							(user_id, app_id_buy, is_from_free_claim, created_at, updated_at)
						values
							(${userId}::int8, ${gameId}::int4, true, now(), now())
					`;
					return { status: "kupon" as const };
				});

				if (claimed.status === "habis") {
					return fail(
						403,
						"Kuota free claim habis. Beli game ini lewat invoice untuk memilikinya.",
						"FREE_CLAIM_HABIS",
					);
				}
				// "kupon" = baru dikonsumsi + insert; "punya" = sempat keburu
				// dimiliki permintaan serempak — re-download tanpa tulisan baru.
			}
		}

		// ------------------------------------------------------------------
		// 200: balas file biner. Semua status selain 200 di atas balik JSON
		// gagal dengan sebab yang jelas, jadi sampai sini file pasti tersedia.
		// ------------------------------------------------------------------
		const gameName = game?.name ?? null;
		const headers = new Headers();
		headers.set("content-type", "application/octet-stream");
		// filename-nya ASCII murni (angka + .lua) — aman tanpa RFC 5987.
		headers.set("content-disposition", `attachment; filename="${gameId}.lua"`);
		headers.set("x-game-id", String(gameId));
		// Nama game bisa berisi non-ASCII (mis. bahasa CJK): header harus
		// ASCII, jadi di-encode URL dan FE yang decode.
		if (gameName) {
			headers.set("x-game-name", encodeURIComponent(gameName));
		}
		headers.set("x-game-size", String(lua.bytes.byteLength));

		return new Response(lua.bytes as unknown as BodyInit, { status: 200, headers });
	},
};

