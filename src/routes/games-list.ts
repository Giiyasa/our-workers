/**
 * GET /api/games — daftar game (list all + pagination + search + filter).
 *
 * `game_list` LEFT JOIN `game_asset`, hasilnya dirapikan oleh shapeGame().
 *
 * Parameter query:
 *   ?page=1              halaman ke-N (mulai dari 1)
 *   ?page_size=24        jumlah baris per halaman (maks 100)
 *   ?search=witcher      cari di game_name/description/genre/category/tags
 *   ?category=RPG        filter kategori (boleh banyak)
 *   ?genre=RPG           filter genre (boleh banyak)
 *   ?tags=open-world     filter tags (boleh banyak, kecocokan sebagian)
 *   ?full=1              sertakan lua_data + metadata + encyription mentah
 *
 * Filter boleh ditulis dua gaya, malah boleh dicampur:
 *   ?genre=RPG&genre=Action
 *   ?genre=RPG,Action
 *
 * FILTER ITU "ATAU" DI DALAM SATU PARAMETER, "DAN" ANTAR PARAMETER:
 *   ?genre=RPG,Action            -> genre RPG atau Action
 *   ?genre=RPG&category=Action   -> (genre RPG) DAN (category Action)
 *
 * Sedangkan `search` berbeda: satu kata kunci dicocokkan ke beberapa kolom
 * sekaligus (game_name ATAU description ATAU genre ATAU category ATAU tags).
 *
 * GAMBAR (header_image): tiap game di halaman ini dicarikan gambar header
 * lewat Steam Store (appdetails) memakai `game_id` sebagai appid Steam.
 * Ambilnya paralel dengan batas, di-cache 24 jam di tepi Cloudflare, dan
 * gagal = `header_image: null` (daftar game tidak pernah ikut gagal).
 * Rinciannya di src/lib/steam.ts.
 *
 * Tidak butuh token: hanya membaca kolom ringkas.
 */

import {
	DEFAULT_PAGE_SIZE,
	MAX_FILTER_LENGTH,
	MAX_FILTER_VALUES,
	MAX_PAGE,
	MAX_PAGE_SIZE,
	MAX_SEARCH_LENGTH,
	TABLE_ASSET,
	TABLE_GAME,
} from "../config";
import { json } from "../lib/http";
import { escapeLike, readBool, readInt, readList } from "../lib/params";
import { fetchHeaderImages } from "../lib/steam";
import { shapeGame } from "../shape";
import type { DbRoute } from "../lib/types";

interface ListInput {
	page: number;
	pageSize: number;
	search: string;
	categories: string[];
	genres: string[];
	tags: string[];
	full: boolean;
}

export const gamesListRoute: DbRoute<ListInput> = {
	method: "GET",
	path: "/api/games",
	token: "none",
	requiresDb: true,
	prepare: ({ url }) => {
		const params = url.searchParams;
		return {
			input: {
				page: readInt(params.get("page"), 1, 1, MAX_PAGE),
				pageSize: readInt(
					params.get("page_size"),
					DEFAULT_PAGE_SIZE,
					1,
					MAX_PAGE_SIZE,
				),
				search: (params.get("search") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
				categories: readList(
					params.getAll("category"),
					MAX_FILTER_VALUES,
					MAX_FILTER_LENGTH,
				),
				genres: readList(
					params.getAll("genre"),
					MAX_FILTER_VALUES,
					MAX_FILTER_LENGTH,
				),
				// Sama seperti kolomnya, nama parameternya tetap "tags" (jamak).
				tags: readList(
					params.getAll("tags"),
					MAX_FILTER_VALUES,
					MAX_FILTER_LENGTH,
				),
				full: readBool(params.get("full")),
			},
		};
	},
	handle: async ({}, input, sql) => {
		const { page, pageSize, search, categories, genres, tags, full } = input;

		const conditions = [];

		// Satu kata kunci, dicocokkan ke beberapa kolom. `description` ikut
		// karena user biasanya mencari dari kalimat deskripsi, bukan genre.
		if (search) {
			const pattern = `%${escapeLike(search)}%`;
			conditions.push(
				sql`(g.game_name ilike ${pattern} or g.description ilike ${pattern} or g.genre ilike ${pattern} or g.category ilike ${pattern} or g.tags ilike ${pattern})`,
			);
		}

		// Daftar nilai: pakai `in ${sql(daftar)}` — cara resmi driver ini
		// (README postgres.js, "Dynamic values and `where in`").
		//
		// JANGAN pakai `= any(${sql.array(daftar)})`. Dua-duanya sudah dicoba
		// dan GAGAL di runtime Worker:
		//   ${daftar}            -> malformed array literal: "RPG,Action"
		//   ${sql.array(daftar)} -> op ANY/ALL (array) requires array on right side
		// Sebabnya: driver menentukan tipe parameter dari Type OID Server, dan
		// pemetaan OID -> OID-array (`typeArrayMap`) tidak terisi di Worker.
		// Akibatnya daftar dikirim sebagai teks biasa, bukan text[].
		// `in ${sql(daftar)}` tidak bergantung pada OID sama sekali: setiap
		// anggota jadi parameter sendiri, jadi koma di dalam nilai pun aman.
		if (categories.length > 0) {
			conditions.push(sql`g.category in ${sql(categories)}`);
		}
		if (genres.length > 0) {
			conditions.push(sql`g.genre in ${sql(genres)}`);
		}
		// Tags di DB berupa teks dipisah koma ("co-op,puzzle,sci-fi"), jadi
		// yang dicari kecocokan SEBAGIAN, bukan kesamaan penuh. Pola digabung
		// dengan OR — artinya sama dengan `any()`, tapi tidak butuh tipe array.
		if (tags.length > 0) {
			const tagConditions = tags.map(
				(tag) => sql`g.tags ilike ${`%${escapeLike(tag)}%`}`,
			);
			conditions.push(sql`(${tagConditions.reduce((a, b) => sql`${a} or ${b}`)})`);
		}

		const where =
			conditions.length > 0
				? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}`
				: sql``;

		// mode ringkas: jangan kirim kolom ±7 KB ke client kalau tidak perlu
		//
		// CATATAN: fragmen di bawah adalah kolom TERAKHIR pada daftar select,
		// jadi keduanya TIDAK boleh berakhir dengan koma. Kalau diberi koma,
		// SQL jadi "... ,\nfrom ..." dan Postgres membalas:
		// syntax error at or near "from".
		const assetColumns = full
			? sql`a.lua_data as asset_lua_data, a.metadata as asset_metadata, a.encyription as asset_encyription`
			: sql`length(a.lua_data) as asset_lua_bytes, length(a.metadata) as asset_metadata_bytes, length(a.encyription) as asset_ency_bytes`;

		const offset = (page - 1) * pageSize;

		// Total dihitung terpisah supaya client tahu ada berapa halaman.
		// Query-nya memakai kondisi yang sama persis, jadi angkanya konsisten
		// dengan isi halamannya.
		const totalRows = await sql`
			select count(*)::int as total
			from ${sql(TABLE_GAME)} g
			${where}
		`;
		const total = Number(totalRows[0]?.total ?? 0);

		// pageSize + 1 supaya kita tahu masih ada halaman berikutnya.
		const rows = await sql`
			select
				g.id, g.game_id, g.game_name, g.description, g.category,
				g.genre, g.tags, g.created_at, g.updated_at,
				a.game_id as asset_game_id,
				a.created_at as asset_created_at,
				a.updated_at as asset_updated_at,
				${assetColumns}
			from ${sql(TABLE_GAME)} g
			left join ${sql(TABLE_ASSET)} a on a.game_id = g.game_id
			${where}
			order by g.id
			limit ${pageSize + 1} offset ${offset}
		`;

		const hasMore = rows.length > pageSize;
		// Baris ke-(pageSize+1) cuma penanda "masih ada halaman berikutnya" —
		// jangan ikut dikirimi Steam permintaan gambar.
		const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

		// header_image diambil dari Steam untuk game di HALAMAN INI saja
		// (maksimum pageSize), diparalel dengan batas di config. Steam lambat
		// atau mati? Semua gambar jadi null, daftar game tetap terkirim.
		const headerImages = await fetchHeaderImages(pageRows.map((row) => row.game_id));

		const data = pageRows.map((row) =>
			shapeGame(
				row,
				full,
				headerImages.get(Number(row.game_id)) ?? null,
			),
		);
		const totalPages = Math.max(1, Math.ceil(total / pageSize));

		return json({
			ok: true,
			count: data.length,
			page,
			page_size: pageSize,
			total,
			total_pages: totalPages,
			has_more: hasMore && page < totalPages,
			full,
			search: search || null,
			filters: {
				category: categories,
				genre: genres,
				tags,
			},
			data,
		});
	},
};
