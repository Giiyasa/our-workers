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
 *   ?search=subway       cari di `name` SAJA. Dengan SEARCH_USE_NORMALIZED_KEY
 *                        (butuh kolom `search_key` dari GAMES_LIST_SEARCH_PATCH.sql)
 *                        kata kunci & nama dinormalisasi (tanpa spasi/tanda baca,
 *                        huruf kecil) + toleransi typo lewat trigram —
 *                        "spiderman" menemukan "Marvel's Spider-Man 2". Tanpa
 *                        flag itu: ilike biasa di `name`.
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

import { COUNT_BUDGET_MS, DEFAULT_PAGE_SIZE, MAX_FILTER_LENGTH, MAX_FILTER_VALUES, MAX_PAGE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, SEARCH_USE_NORMALIZED_KEY, TABLE_ASSET, TABLE_GAME, WORD_SIMILARITY_MIN } from '../config';
import { json } from '../lib/http';
import { hasLevenshtein } from '../lib/fuzzy';
import { escapeLike, readInt, readList } from '../lib/params';
import { normalizeSearchKey } from '../lib/search';
import { shapeGame } from '../shape';
import type { DbRoute } from '../lib/types';

interface ListInput {
	page: number;
	pageSize: number;
	countOnly: boolean;
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
				countOnly: params.get('count_only') === 'true',
				search: (params.get('search') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
				genres,
				categories,
				tagWarning,
			},
		};
	},
	handle: async ({}, input, sql) => {
		const { page, pageSize, countOnly, search, genres, categories, tagWarning } = input;

		const conditions = [];

		// Satu kata kunci, hanya `name`. Dua jalur:
		//
		// - NORMALIZED (SEARCH_USE_NORMALIZED_KEY, butuh kolom `search_key`
		//   dari GAMES_LIST_SEARCH_PATCH.sql): nama dan kata kunci sama-sama
		//   dinormalisasi (tanpa spasi/tanda hubung/titik dua/apostrof, huruf
		//   kecil, tanpa diakritik). Kunci dipakai di WHERE (tiga lapis
		//   kecocokan, lihat di bawah) dan di ORDER BY (peringkat relevansi).
		//
		// - ILIKE (fallback lama): pola %…% langsung di `name`. Selalu benar
		//   secara semantik, tapi lambat (seq scan di ±180 ribu baris) dan
		//   tidak toleran typo.
		// Kata kunci ternormalisasi + pola LIKE-nya dipakai dua tempat:
		// kondisi WHERE dan peringkat ORDER BY.
		let rankKey: string | null = null;
		let rankPattern = "";

		if (search) {
			const key = normalizeSearchKey(search);
			if (SEARCH_USE_NORMALIZED_KEY && key) {
				rankKey = key;
				rankPattern = `%${key}%`;
				// Ekstensi fuzzystrmatch opsional: diprobe sekali per isolate.
				// Tanpa ekstensi ini lapis 2 (typo kata utuh) dilewati —
				// pencarian tetap berfungsi, hanya tidak menangkap typo kata
				// utuh seperti "wticher".
				const lev = await hasLevenshtein(sql);
				// Lapis kecocokan, dari paling presisi:
				//
				//  1. MENGANDUNG — kunci ada di dalam nama ternormalisasi:
				//     "witcher 3" menemukan "The Witcher 3: Wild Hunt"
				//     (thewitcher3wildhunt), "spiderman" menemukan
				//     "Marvel's Spider-Man 2" (marvelsspiderman2).
				//     Didorong index GIN trigram (game_lists_search_trgm_idx).
				//  2. TYPO KATA UTUH (butuh fuzzystrmatch) — operator %
				//     (trigram, index GIN) memilih kandidat, lalu jarak edit
				//     <= 2 menyaring ulang: "wticher" menemukan "WATCHER"
				//     (jarak 2), tapi "Spider Subway" TIDAK ikut untuk
				//     "spiderman" (jarak 6). Dipasang HANYA kalau fungsi
				//     levenshtein ada — Postgres memvalidasi fungsi saat parse,
				//     jadi memanggilnya dalam kondisi `false` tidak menyelamatkan
				//     kueri, lapisnya memang harus tidak ada di SQL-nya.
				//  3. TYPO DI DALAM FRASA — "spider an" tetap menemukan
				//     "Marvel's Spider-Man 2": operator <% (kecocokan kata di
				//     dalam teks, didukung index GIN) memilih kandidat supaya
				//     tidak seq scan, lalu word_similarity() menyaring dengan
				//     ambang eksplisit WORD_SIMILARITY_MIN.
				const layers = [sql`g.search_key like ${rankPattern}`];
				if (lev) {
					layers.push(
						sql`(g.search_key % ${key} and levenshtein(g.search_key, ${key}) <= 2)`,
					);
				}
				layers.push(
					sql`(
						length(${key}) >= 5
						and ${key} <% g.search_key
						and word_similarity(${key}, g.search_key) >= ${WORD_SIMILARITY_MIN}
					)`,
				);
				conditions.push(sql`(${layers.reduce((a, b) => sql`${a} or ${b}`)})`);
			} else {
				// Flag mati ATAU kunci jadi kosong (cuma tanda baca/spasi) —
				// jaring pengaman: cari di nama mentah saja.
				const pattern = `%${escapeLike(search)}%`;
				conditions.push(sql`g.name ilike ${pattern}`);
			}
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

		// Steam redirects these older AppIDs to the newer product pages. Keep
		// both database rows: assets and purchases still refer to their AppID.
		// Only collapse these verified pairs in the catalog response. Never
		// collapse arbitrary titles with the same name (different editions exist).
		const duplicateIds = [1962660, 3595230, 2519060, 3595270];
		const canonicalId = sql`case g.app_id
			when 1962660 then 3595230
			when 2519060 then 3595270
			else g.app_id end`;
		const pairWhere = conditions.length > 0
			? sql`${where} and g.app_id in ${sql(duplicateIds)}`
			: sql`where g.app_id in ${sql(duplicateIds)}`;
		// A row with actual downloadable assets wins. Otherwise use Steam's
		// current AppID. This leaves the card pointing to a usable AppID.
		const winner = sql`select app_id from (
			select g.app_id, row_number() over (
				partition by ${canonicalId}
				order by case when exists (
					select 1 from ${sql(TABLE_ASSET)} a
					where a.game_id = g.app_id and
						(coalesce(octet_length(a.lua_data), 0) > 0 or coalesce(octet_length(a.meta_data), 0) > 0)
				) then 0 else 1 end,
				case when g.app_id in (3595230, 3595270) then 0 else 1 end, g.id
			) as duplicate_rank
			from ${sql(TABLE_GAME)} g ${pairWhere}
		) pair_rows where duplicate_rank = 1`;
		const visible = sql`(g.app_id not in ${sql(duplicateIds)} or g.app_id in (${winner}))`;
		const visibleWhere = conditions.length > 0 ? sql`${where} and ${visible}` : sql`where ${visible}`;

		// Count once per filter independently of page fetching. No sort/window
		// or page cap: the desktop can load cards first, then the exact total.
		if (countOnly) {
			const result = await sql`select count(*)::int as total from ${sql(TABLE_GAME)} g ${visibleWhere}`;
			const total = Number(result[0]?.total);
			if (!Number.isSafeInteger(total) || total < 0) throw new Error('Catalog count unavailable');
			return json({ ok: true, total, total_approximate: false, page_size: pageSize,
				total_pages: Math.max(1, Math.ceil(total / pageSize)) });
		}

		// Objek peringkat pencarian: non-null hanya saat pencarian aktif di
		// jalur ternormalisasi. Dipakai WHERE (di atas), ORDER BY, dan
		// penentu bentuk query count di bawah.
		const searchRank = rankKey === null ? null : { key: rankKey, pattern: rankPattern };

		// Urutan hasil. Saat pencarian aktif: relevansi dulu —
		//   1. mengandung kata kunci ("witcher3" di dalam thewitcher3wildhunt)
		//   2. sama persis dengan kata kunci
		//   3. kata kunci sebagai KATA UTUH di nama asli — regex \y (batas
		//      kata) membuat "witcher" menemukan "The Witcher 3" tanpa
		//      mengangkat "Switcher" (witcher ada di dalam sw-itcher, tapi
		//      bukan kata utuh). Hanya dijalankan untuk kunci tanpa spasi,
		//      karena \y cocok di kedua sisi spasi juga — kunci berspasi
		//      ("witcher 3") di sini justru mengangkat semua varian judul,
		//      bukan judul yang sama persis.
		//   4. makin mirip trigram makin naik (typo ditempatkan dekat
		//      tujuannya); word_similarity (per kata, tanpa padding) lebih
		//      adil untuk nama pendek daripada similarity() padded.
		// lalu tanggal rilis sebagai penentu seri. Tanpa pencarian: perilaku
		// lama, terbaru rilis dulu.
		//
		// Fragmen urutan ini dipakai DUA kali (window row_number + order by
		// luar) supaya keduanya dijamin identik.
		const wordTier = searchRank && !/\s/.test(searchRank.key)
			? sql`, case when g.name ~* ${`\\y${searchRank.key}\\y`} then 0 else 1 end`
			: sql``;
		const orderFrag = searchRank
			? sql`case when g.search_key like ${searchRank.pattern} then 0 else 1 end, case when g.search_key = ${searchRank.key} then 0 else 1 end${wordTier}, word_similarity(${searchRank.key}, g.search_key) desc, g.release_date desc nulls last, g.id`
			: sql`g.release_date desc nulls last, g.id`;

		const offset = (page - 1) * pageSize;

		// Total dihitung dengan kondisi yang sama persis, jadi angkanya
		// konsisten dengan isi halamannya. `catch(() => null)`: kalau count
		// gagal, permintaan tetap dilayani dengan total perkiraan (lihat
		// `total_approximate` di bawah) — satu query gagal tidak perlu
		// menjatuhkan seluruh katalog.
		//
		// Saat pencarian aktif, count dipangkus window row_number: Postgres
		// berhenti memproses window segera setelah nomor halaman terakhir
		// yang relevan tercapai. Tanpa itu, count harus memproses SEMUA
		// baris yang cocok — "spiderman" di katalog Steam menyentuh ribuan
		// judul bermiripan lemah, dan menghitung semuanya justru lebih lambat
		// daripada membaca halamannya. Tanpa pencarian: count biasa.
		const countPromise = searchRank
			? sql`
					select coalesce(max(rn), 0)::int as total
					from (
						select row_number() over (order by ${orderFrag}) as rn
						from ${sql(TABLE_GAME)} g
						${visibleWhere}
					) w
					where w.rn <= ${offset + pageSize}
				`
				.then((r) => Number(r[0]?.total ?? 0))
				.catch(() => null)
			: sql`
					select count(*)::int as total
					from ${sql(TABLE_GAME)} g
					${visibleWhere}
				`
				.then((r) => Number(r[0]?.total ?? 0))
				.catch(() => null);

		// pageSize + 1 supaya "masih ada halaman berikutnya" terbaca dari
		// jumlah baris, tanpa query ketiga. Baris lebihnya tidak ikut dikirim.
		// Urutan mengikuti orderFrag — saat pencarian aktif berarti relevansi
		// dulu (mengandung > sama persis > kemiripan trigram), baru tanggal
		// rilis sebagai penentu seri.
		const rows = await sql`
			select
				g.id,
				g.app_id,
				g.is_unavailable_game,
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
			${visibleWhere}
			order by ${orderFrag}
			limit ${pageSize + 1} offset ${offset}
		`;

		// Anggaran count: beri kesempatan query count selesai sampai
		// COUNT_BUDGET_MS. Setelah itu respons dikirim dengan total perkiraan
		// — count 180 ribu baris dengan filter search boleh butuh detik-an,
		// dan user hanya butuh angka pasti untuk gambaran jumlah hasil.
		const totalSettled = await Promise.race([
			countPromise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), COUNT_BUDGET_MS)),
		]);
		const hasMore = rows.length > pageSize;
		const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
		// A capped search count cannot be the exact total while lookahead
		// proves another row exists. Preserve fast counts, but label them honestly.
		const minimumTotal = pageRows.length > 0 ? offset + pageRows.length + (hasMore ? 1 : 0) : 0;
		const totalApproximate = totalSettled === null || !Number.isSafeInteger(totalSettled) ||
			totalSettled < minimumTotal || (searchRank !== null && hasMore);
		const total = totalApproximate ? minimumTotal : totalSettled;
		const totalPages = Math.max(1, Math.ceil(total / pageSize));

		return json({
			ok: true,
			count: pageRows.length,
			page,
			page_size: pageSize,
			total,
			total_approximate: totalApproximate,
			total_pages: totalPages,
			has_more: hasMore,
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
