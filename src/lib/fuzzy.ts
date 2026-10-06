/**
 * Deteksi sekali-per-isolate: apakah fungsi `levenshtein` tersedia di database.
 *
 * Fungsi itu datang dari ekstensi `fuzzystrmatch` (supabase/GAMES_LIST_SEARCH_PATCH.sql,
 * bagian lapis 2 pencarian). Rute katalog TIDAK boleh 500 hanya karena satu
 * langkah SQL manual terlewat — jadi hasilnya dipakai untuk memilih bentuk
 * WHERE: dengan lapis typo levenshtein, atau tanpa (lapis contains + word
 * similarity tetap jalan).
 *
 * Probe di-cache untuk umur isolate: satu koneksi ekstra hanya pada pencarian
 * pertama, bukan setiap permintaan. Kalau ekstensi baru dipasang saat isolate
 * masih hidup, hasil `false` bisa basi sampai isolate didaur ulang — bukan
 * masalah praktis, karena pemasangan ekstensi memang dikerjakan sebelum deploy.
 */

let probe: Promise<boolean> | null = null;

export function hasLevenshtein(sql: import("./db").Sql): Promise<boolean> {
	probe ??= sql`select levenshtein('abc'::text, 'abd'::text) as d`
		.then(() => true)
		.catch(() => false);
	return probe;
}
