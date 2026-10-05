/**
 * GET /api/games — daftar game (list all + pagination + search + filter).
 *
 * Bergantung penuh pada `game_list`: kolom `image` (URL CDN Steam), `genre`/
 * `categories` (array), `publishers`, dan `release_date` SUDAH ADA di tabel
 * (contoh baris: app_id 10 Counter-Strike, image "shared.akamai.steamstatic.com/
 * store_item_assets/steam/apps/10/header.jpg?t=...", genre ["Action","Shooter"],
 * categories ["Multi-player","PvP",...], release_date "2000-11-01").
 *
 * TIDAK ADA subrequest Steam lagi — versi sebelumnya mem-fetch appdetails Steam
 * per game untuk `header_image`; itu dihapus ("hapus aja fungsinya"). Satu
 * permintaan = dua query Postgres (count + halaman), tanpa jaringan keluar.
 * `game_asset` tidak dilibatkan lagi di rute ini.
 *
 * Parameter query:
 *   ?page=1              halaman ke-N (mulai dari 1, maks 10 000)
 *   ?page_size=24        jumlah baris per halaman (default 24, maks 100)
 *   ?search=subway       cari di `name` SAJA (ilike, tak peduli huruf)
 *   ?genre=Action        filter genre (banyak nilai = ATAU)
 *   ?category=PvP        filter category (banyak nilai = ATAU)
 *
 * Filter boleh ditulis dua gaya, malah boleh dicampur:
 *   ?genre=Action&genre=Shooter
 *   ?genre=Action,Shooter
 *
 * SEMANTIK FILTER:
 *   dalam satu parameter = ATAU; antar-parameter = DAN:
 *   ?genre=Action,Shooter        -> genre Action ATAU Shooter
 *   ?genre=Action&category=PvP   -> (genre Action) DAN (category PvP)
 *
 * Param `tags`/`full` versi lama TIDAK ADA lagi — kolomnya memang sudah tak
 * ada di tabel. `?tags=...` diterima tapi dibalas dengan peringatan di
 * `filters.tag_warning` (lihat prepare), bukan diabaikan diam-diam.
 */

import { DEFAULT_PAGE_SIZE, MAX_FILTER_LENGTH, MAX_FILTER_VALUES, MAX_PAGE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, TABLE_ASSET, TABLE_GAME } from '../config';
import { json } from '../lib/http';
import { escapeLike, readInt, readList } from '../lib/params';
import { shapeGame } from '../shape';
import type { DbRoute } from '../lib/types';

interface ListInput {
	page: number;
	pageSize: number;
	search: string;
	genres: string[];
	categories: string[];
	tagWarning: string | null;
}

export const gamesListRoute: DbRoute<ListInput> = {
	method: 'GET',
	path: '/api/games',
	token: 'none',
	requiresDb: true,
	prepare: ({ url }) => {
		const params = url.searchParams;
		const genres = readList(params.getAll('genre'), MAX_FILTER_VALUES, MAX_FILTER_LENGTH);
		const categories = readList(params.getAll('category'), MAX_FILTER_VALUES, MAX_FILTER_LENGTH);
		// Param versi lama yang kolomnya sudah hilang: diterima, dibalas
		// dengan peringatan, bukan diabaikan diam-diam.
		const tagWarning = params.getAll('tags').length ? 'Param ?tags sudah tidak didukung — kolom tags hilang dari tabel game_list.' : null;

		return {
			input: {
				page: readInt(params.get('page'), 1, 1, MAX_PAGE),
				pageSize: readInt(params.get('page_size'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
				search: (params.get('search') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
				genres,
				categories,
				tagWarning,
			},
		};
	},
	handle: async ({}, input, sql) => {
		const { page, pageSize, search, genres, categories, tagWarning } = input;

		const conditions = [];

		// Satu kata kunci, hanya `name`. ILIKE = tidak peduli huruf besar/kecil;
		// escapeLike menetralkan %, _ dan \ dari nilai pengguna.
		if (search) {
			const pattern = `%${escapeLike(search)}%`;
			conditions.push(sql`g.name ilike ${pattern}`);
		}

		// Filter genre/category. Ketiganya kolom **text[]** (bukan jsonb!)
		// di tabel `game_lists` — pencocokan yang benar: keanggotaan `= ANY`
		// ("kolom mengandung elemen ini"). Antara nilai = ATAU (salah satu
		// genre cukup), sesuai semantik filter lama. Nilai diparameterisasi
		// sebagai teks biasa; driver tidak perlu memetakan tipe array.
		if (genres.length > 0) {
			const genreConditions = genres.map((genre) => sql`${genre} = any(g.genre)`);
			conditions.push(sql`(${genreConditions.reduce((a, b) => sql`${a} or ${b}`)})`);
		}
		if (categories.length > 0) {
			const categoryConditions = categories.map((category) => sql`${category} = any(g.categories)`);
			conditions.push(sql`(${categoryConditions.reduce((a, b) => sql`${a} or ${b}`)})`);
		}

		const where = conditions.length > 0 ? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}` : sql``;

		// Total dihitung dengan kondisi yang sama persis, jadi angkanya
		// konsisten dengan isi halamannya.
		const totalRows = await sql`
			select count(*)::int as total
			from ${sql(TABLE_GAME)} g
			${where}
		`;
		const total = Number(totalRows[0]?.total ?? 0);

		const offset = (page - 1) * pageSize;

		// pageSize + 1 supaya "masih ada halaman berikutnya" terbaca dari
		// jumlah baris, tanpa query ketiga. Baris lebihnya tidak ikut dikirim.
		//
		// Urutan permintaan user: terbaru dulu berdasarkan tanggal rilis.
		// NULLS LAST agar yang belum punya tanggal tidak menggantung di atas;
		// g.id sebagai penentu seri kalau tanggalnya sama.
		const rows = await sql`
			select
				g.id,
				g.app_id,
				g.name,
				g.image,
				g.description,
				g.genre,
				g.categories,
				g.publishers,
				g.release_date,
				g.created_at,
				g.updated_at
			from ${sql(TABLE_GAME)} g
			inner join ${sql(TABLE_ASSET)} a
				on g.app_id = a.game_id
			${where}
			order by g.release_date desc nulls last, g.id
			limit ${pageSize + 1} offset ${offset}
		`;

		const hasMore = rows.length > pageSize;
		const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
		const totalPages = Math.max(1, Math.ceil(total / pageSize));

		return json({
			ok: true,
			count: pageRows.length,
			page,
			page_size: pageSize,
			total,
			total_pages: totalPages,
			has_more: hasMore && page < totalPages,
			search: search || null,
			filters: {
				genre: genres,
				category: categories,
				tag_warning: tagWarning,
			},
			data: pageRows.map(shapeGame),
		});
	},
};
