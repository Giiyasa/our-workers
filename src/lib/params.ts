/**
 * Pembaca nilai query string.
 *
 * Semua fungsi di sini menerima string mentah dari URL dan mengembalikan nilai
 * yang sudah aman dipakai — tidak ada `Number()` atau `split()` liar yang
 * tersebar di file rute.
 */

/**
 * Ambil nilai angka dengan batas aman.
 *
 * PENTING: `Number(null)` bernilai 0 (bukan NaN), dan `Number("")` juga 0.
 * Kalau tidak dicegat, permintaan tanpa `?limit=` akan memakai limit 0 —
 * bukan angka bawaan yang kita maksud. Jadi string kosong/null harus
 * ditangani lebih dulu, jangan langsung dilempar ke Number().
 */
export function readInt(
	raw: string | null,
	fallback: number,
	min: number,
	max: number,
): number {
	if (raw === null || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Baca bendera dari query string. Nilai tak dikenal memakai `fallback`. */
export function readBool(raw: string | null, fallback = false): boolean {
	if (raw === null) return fallback;
	const v = raw.trim().toLowerCase();
	if (v === "") return fallback;
	return ["1", "true", "ya", "yes", "on"].includes(v);
}

/**
 * Netralkan karakter khusus `LIKE`/`ILIKE` sebelum nilai user ditempelkan ke
 * pola pencarian.
 *
 * Tanpa ini, mencari "%" atau "_" berubah arti: "%" jadi "cocok dengan apa
 * pun" dan "_" jadi "cocok dengan satu huruf". Backslash dipakai sebagai
 * karakter pelindung karena Postgres `LIKE` memang memakai `\` secara bawaan.
 */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Baca parameter filter yang boleh punya BANYAK nilai.
 *
 * Dua gaya penulisan diterima (boleh dicampur):
 *   ?genre=RPG&genre=Action      (diulang)
 *   ?genre=RPG,Action            (dipisah koma)
 *   ?genre=RPG&genre=Action,Puzzle
 *
 * Nilai kosong dibuang, duplikat (tanpa peduli huruf besar/kecil) dibuang, dan
 * jumlah serta panjang nilai dibatasi supaya URL raksasa tidak bisa memaksa
 * query SQL yang berat.
 */
export function readList(
	values: readonly string[],
	maxValues = 50,
	maxLength = 64,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		for (const part of raw.split(",")) {
			const value = part.trim().slice(0, maxLength);
			if (!value) continue;
			const key = value.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(value);
			if (out.length >= maxValues) return out;
		}
	}
	return out;
}
