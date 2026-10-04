/**
 * GET /api/account — satu permintaan untuk seluruh halaman Account.
 *
 * Baca tiga hal untuk user yang SEDANG BERSERI (identitas dari sesi, bukan
 * dari client):
 *
 *   1. `user`        -> profil akun: email + sisa kupon free claim
 *                       (`free_claim_game`). Password hash dan machine_info
 *                       tidak pernah ikut — bentuk user dari shapeUser().
 *   2. `owned_games` -> game yang SUDAH DIMILIKI (user_list_game). KHUSUS
 *                       access_role_code 4 (role populate invoice): tiap
 *                       barisnya bermakna "dia punya game ini" — app_id_buy
 *                       adalah Steam App ID hasil klaim invoice. Role lain
 *                       dibalas `list_game_kosong: true` + daftar kosong
 *                       karena baris klaimnya app_id_buy = 0 (tidak menunjuk
 *                       game apa pun).
 *   3. `purchase_history` -> invoice pada `history_purchase` yang SEDANG
 *                       DIPAKAI untuk menyatakan kepemilikan yang sama:
 *                       baris dengan app_id_buy = game_id invoice dipetakan
 *                       ke baris history_purchase milik invoice itu. Ini
 *                       pemetaan umum: klaim role 4 menyalin game_id invoice
 *                       ke app_id_buy, jadi kecocokan `user_list_game.app_id_buy
 *                       = history_purchase.game_id` adalah definisi
 *                       "invoice ini yang memberi game ini" — bukan asumsi.
 *
 * Satu rute, bukan tiga: halaman Account butuh ketiganya bersama-sama; tiga
 * rute berarti tiga kali pemeriksaan sesi untuk satu layar.
 *
 * Gambar sampul dari Steam Store (fetchHeaderImages — kebijakan header_image
 * sama persis dengan GET /api/games); gagal fetch = null, daftar tetap sah.
 *
 * BENTUK balasan (200):
 *   { ok: true,
 *     user: shapeUser(...),
 *     list_game_kosong: boolean,   // true = role bukan 4
 *     owned_games: [{ app_id_buy, game_id, game_name, has_asset,
 *                     header_image, owned_since }],
 *     purchase_history: [{ id, invoice_number, game_id, role_klaim:
 *                          boolean, game_diberi: number[], 
 *                          created_at, updated_at }] }
 *
 * STATUS: 401 sesi tidak sah / AKUN_TIDAK_ADA — sama dengan rute sesi lain.
 */

import {
	INVOICE_CLAIM_ROLE_CODE,
	TABLE_ASSET,
	TABLE_GAME,
	TABLE_HISTORY_PURCHASE,
	TABLE_USER_LIST_GAME,
} from "../config";
import { findUserById, shapeUser } from "../lib/auth-store";
import { fail, json } from "../lib/http";
import { fetchHeaderImages } from "../lib/steam";
import {
	preflightSession,
	requireSession,
	sessionFailStatus,
} from "../lib/session-guard";
import type { DbRoute } from "../lib/types";

/** Satu baris `user_list_game` yang dibutuhkan rute ini. */
interface OwnedRow {
	/** int4 -> number; Steam App ID yang dibeli (role 4). */
	app_id_buy: number;
	created_at: Date | string;
}

/** Satu baris `game_list` hasil JOIN ke daftar appid milik user. */
interface CatalogRow {
	game_id: number;
	game_name: string;
	/** NULL = game belum punya asset (LEFT JOIN game_asset tidak menemukan). */
	asset_game_id: number | null;
}

/** Satu baris `history_purchase` yang `is_invoice_used = true`. */
interface PurchaseRow {
	/** int8 -> driver mengembalikan string. */
	id: string;
	invoice_number: string;
	/** int4; null = invoice belum tertaut game. */
	game_id: number | null;
	created_at: Date | string;
	updated_at: Date | string;
}

/** Date/string dari driver -> string ISO. */
function iso(value: Date | string | null): string | null {
	if (value instanceof Date) return value.toISOString();
	return typeof value === "string" ? value : null;
}

export const accountRoute: DbRoute<Record<string, never>> = {
	method: "GET",
	path: "/api/account",
	token: "none",
	requiresDb: true,

	prepare: ({ request, env }) => {
		// Sesi diperiksa SEBELUM database dibuka — pola yang sama dengan
		// seluruh rute bersesi (lihat routes/auth-me.ts).
		const pre = preflightSession(request, env);
		if (!pre.ok) return fail(pre.status, pre.error, pre.code);
		return { input: {} };
	},

	handle: async ({ request, env }, _input, sql) => {
		const check = await requireSession(
			sql,
			env,
			request,
			request.headers.get("x-user-id"),
		);
		if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
		const userId = check.session.userId;

		const user = await findUserById(sql, userId);
		if (!user) {
			return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");
		}

		// ------------------------------------------------------------------
		// Role selain 4: baris klaimnya app_id_buy = 0 — tidak menunjuk game
		// apa pun. Daftar kepemilikan sengaja balik kosong + penanda, dan FE
		// menampilkan makna role-nya, bukan daftar kosong yang terlihat rusak.
		// ------------------------------------------------------------------
		if (user.access_role_code !== INVOICE_CLAIM_ROLE_CODE) {
			return json({
				ok: true,
				user: shapeUser(user),
				list_game_kosong: true,
				owned_games: [],
				purchase_history: [],
			});
		}

		// Kepemilikan per game: user bisa klaim game sama lewat invoice beda
		// (dua invoice memuat game_id sama). DISTINCT ON menyisakan satu baris
		// per game — yang TERTUA, jadi urutannya stabil dan kronologis.
		const ownedRows = await sql<OwnedRow[]>`
			select distinct on (app_id_buy)
				app_id_buy, created_at
			from ${sql(TABLE_USER_LIST_GAME)}
			where user_id = ${userId}::int8
				and app_id_buy <> 0
			order by app_id_buy, created_at asc
		`;
		const ownedIds = ownedRows.map((row) => Number(row.app_id_buy));

		// ------------------------------------------------------------------
		// Detail game untuk yang dimiliki. Kartu membutuhkan nama + sampul,
		// jadi detailnya dipanen dari game_list untuk appid yang dimiliki.
		// Judul yang sudah tidak ada di game_list tetap tampil sebagai
		// kepemilikan, cuma tanpa nama (game_name null di FE).
		// ------------------------------------------------------------------
		const ownedGames = ownedRows.map((row) => {
			return {
				app_id_buy: row.app_id_buy,
				owned_since: iso(row.created_at),
			};
		});

		// purchase history: baris is_invoice_used = true, dicocokkan dengan
		// kepemilikan yang sama (app_id_buy = game_id). Belum punya game apa
		// pun berarti belum ada invoice yang "membayar" kepemilikan — daftar
		// kosong tanpa menyentuh query `in ()` yang tak sah.
		const purchaseRows =
			ownedIds.length > 0
				? await sql<PurchaseRow[]>`
					select hp.id, hp.invoice_number, hp.game_id, hp.created_at, hp.updated_at
					from ${sql(TABLE_HISTORY_PURCHASE)} hp
					where hp.is_invoice_used = true
						and hp.game_id in ${sql(ownedIds)}
					order by hp.created_at desc
				`
				: [];

		// Kartu katalog butuh nama game + penanda asset. Ambil dari game_list
		// untuk semua appid yang dimiliki; game yang sudah dihapus dari
		// game_list tetap tampil sebagai kepemilikan, hanya tanpa nama
		// (game_name null — FE menampilkan "Judul tidak tersedia").
		const gameIdsForCatalog = ownedIds.filter((id) => id > 0);
		const catalogRows: CatalogRow[] =
			gameIdsForCatalog.length > 0
				? await sql<CatalogRow[]>`
					select g.app_id, g.name, a.game_id as asset_game_id
					from ${sql(TABLE_GAME)} g
					left join ${sql(TABLE_ASSET)} a on a.game_id = g.app_id
					where g.app_id in ${sql(gameIdsForCatalog)}
					order by g.app_id
				`
				: [];
		const catalogByName = new Map(catalogRows.map((row) => [Number(row.game_id), row]));

		// header_image dari Steam untuk kepemilikan — kebijakan sama dengan
		// daftar katalog: gagal fetch = null tanpa membuat rute gagal.
		const headerImages = await fetchHeaderImages(gameIdsForCatalog);

		const owned = ownedGames.map((row) => {
			const game = catalogByName.get(row.app_id_buy);
			return {
				app_id_buy: row.app_id_buy,
				game_id: game?.game_id ?? null,
				game_name: game?.game_name ?? null,
				has_asset: game?.asset_game_id != null,
				header_image: headerImages.get(row.app_id_buy) ?? null,
				owned_since: row.owned_since,
			};
		});

		// Riwayat pembelian yang DIPAKAI (is_invoice_used = true), dicocokkan
		// ke kepemilikan lewat app_id_buy = game_id. Kaitannya nyata: klaim
		// role 4 MENYALIN game_id invoice ke app_id_buy, jadi kecocokan itu
		// definisi "invoice ini yang memberi game ini". Catatan jujur: tabel
		// history_purchase tidak menyimpan user_id, jadi kaitan itu tak bisa
		// dibuktikan per-baris — yang dijamin HANYA satu-ke-satu oleh is_invoice_used.
		// Kelak bisa diperketat kalau tabelnya menambah kolom pemilik.
		const purchaseHistory = purchaseRows.map((row) => ({
			id: row.id,
			invoice_number: row.invoice_number,
			game_id: row.game_id,
			game_name: catalogByName.get(row.game_id ?? 0)?.game_name ?? null,
			created_at: iso(row.created_at),
			updated_at: iso(row.updated_at),
		}));

		return json({
			ok: true,
			user: shapeUser(user),
			list_game_kosong: false,
			owned_games: owned,
			purchase_history: purchaseHistory,
		});
	},
};
