/**
 * Normalisasi kata kunci pencarian.
 *
 * Tujuannya: "Spider-Man", "spiderman", "Spider Man", "Marvel's Spider-Man"
 * di pencarian dibaca sama seperti orang menulisnya — tanpa tanda hubung,
 * titik dua, apostrof, spasi, dan tanpa peduli huruf besar/kecil atau tanda
 * diakritik (Pokémon -> pokemon).
 *
 * !! WAJIB SAMA dengan ekspresi kolom `search_key` di
 *    supabase/GAMES_LIST_SEARCH_PATCH.sql (regexp_replace lower nama).
 *    Kalau salah satu diubah, ubah KEDUANYA — kalau tidak, pencarian
 *    diam-diam berhenti cocok dengan isi DB.
 *
 * Fungsi ini murni (tanpa DB, tanpa HTTP) sehingga bisa diuji di
 * test/units.spec.ts.
 */
export function normalizeSearchKey(value: string): string {
	return value
		// Pecah huruf berdiakritik jadi huruf dasar + tanda (é -> e + ́ )
		.normalize("NFKD")
		// Buang tanda pelaturnya
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		// Buang semua yang bukan huruf/angka: spasi, tanda hubung, titik dua,
		// apostrof (baik ' maupun ’), titik, dll.
		.replace(/[^a-z0-9]/g, "");
}
