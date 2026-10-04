/**
 * Bentuk JSON yang dikirim ke client.
 *
 * Hasil LEFT JOIN yang datar (kolom game_* dan asset_* sejajar) dirapikan jadi
 * bersarang: { ...game, asset: { has_asset, ... } }.
 */



/**
 * Bentuk JSON yang dikirim ke client untuk satu baris `game_list`.
 *
 * Struktur tabel baru (kolom array + image + release_date) dibersihkan di SATU
 * tempat ini supaya rute daftar tetap pendek dan client tidak perlu menebak
 * bentuk kolom:
 *
 *   - `image` di DB disimpan TANPA protokol ("shared.akamai.steamstatic.com/
 *     ..."). Untuk <img src> harus ada skema — diawali "https://" di sini.
 *     Nilai yang sudah punya "http(s)://" dibiarkan; nilai kosong/null -> null.
 *   - `genre`/`categories`/`publishers` bisa datang sebagai array (jsonb di-
 *     parse otomatis driver) ATAU teks dipisah koma (kalau kolomnya teks).
 *     Keduanya diratakan jadi array string.
 *   - Field lain dipetakan apa adanya.
 *
 * Sekarang hanya GET /api/games yang memakainya — GET /api/games/:game_id
 * mengambil datanya dari Steam Store, bukan dari tabel ini.
 */

export function shapeGame(row: Record<string, any>) {
	return {
		id: row.id,
		app_id: row.app_id,
		name: row.name ?? null,
		image: pickCoverImage(row.image),
		description: row.description ?? null,
		genre: toStrArray(row.genre),
		categories: toStrArray(row.categories),
		publishers: toStrArray(row.publishers),
		release_date: row.release_date ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
	};
}

/** URL sampul yang layak dipasang ke <img src>: selalu punya skema http(s). */
export function pickCoverImage(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	// "//host/path" -> serap protokol halaman; di WebView tidak ada halaman
	// http, jadi paksa https.
	if (trimmed.startsWith("//")) return `https:${trimmed}`;
	return `https://${trimmed}`;
}

/**
 * Kolom "array" yang bisa datang dalam 3 bentuk:
 *
 *   1. array JS        — driver sudah parse (jsonb atau array Postgres yang
 *                        mapping tipenya jalan) -> pakai apa adanya.
 *   2. teks koma       — kolom lama bertipe text ("Action, Shooter").
 *   3. literal Postgres — `fetch_types: false` (setting lib/db.ts) membuat
 *                        driver TIDAK mem-parse tipe array[]: barisnya datang
 *                        sebagai SATU string `{"Action","Shooter"}`. Tanda
 *                        kurung kurawal dibuang, elemen ber-kutip dipecah
 *                        sesuai aturan literal array Postgres, setiap
 *                        elemen di-unescape (\ dan ").
 *
 * Semua diratakan jadi array string, terbuang yang kosong.
 */
export function toStrArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}

	if (typeof value === "string") {
		// Literal array Postgres: diawali "{" dan diakhiri "}".
		if (value.startsWith("{") && value.endsWith("}")) {
			const body = value.slice(1, -1);
			const out: string[] = [];
			let current = "";
			let quoted = false;

			for (let i = 0; i < body.length; i++) {
				const char = body[i];

				if (quoted) {
					if (char === "\\" && i + 1 < body.length) {
						current += body[i + 1];
						i++;
					} else if (char === '"') {
						quoted = false;
					} else {
						current += char;
					}
					continue;
				}

				if (char === '"') {
					quoted = true;
				} else if (char === ",") {
					out.push(current.trim());
					current = "";
				} else {
					current += char;
				}
			}
			out.push(current.trim());

			return out.filter(Boolean);
		}

		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}

	return [];
}
