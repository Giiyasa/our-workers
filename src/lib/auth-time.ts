/**
 * Jembatan antara "waktu" di database dan di JavaScript.
 *
 * Satu aturan yang dipegang seluruh rute auth: **waktu ditentukan DATABASE**,
 * bukan jam Worker dan bukan jam komputer user. Jam komputer user bisa
 * diubah-ubah; kalau masa berlaku token/OTP dipercayakan ke sana, "force
 * logout" tinggal dibatalkan dengan memundurkan jam.
 *
 * Bentuk nilai dari driver (`postgres.js`):
 *   timestamptz  -> Date
 *   interval     -> string, mis. "300.123456" (detik) atau "1 day 02:03:04"
 *   int4         -> number
 *   int8         -> STRING ("12", bukan 12) — jangan lupa `String(...)`
 */

export interface DbTime {
	/** Waktu sekarang menurut database. */
	now: Date;
	/** Umur satu baris, dari `now() - created_at`. */
	ageS: number;
}

/** Baca "berapa detik" dari kolom interval, jadi `null` kalau tak jelas. */
export function readSeconds(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;

	const text = value.trim();
	if (!text) return null;

	// Postgres menulis interval sebagai "<jumlah> <satuan> [...]" dan/atau "HH:MM:SS".
	let total = 0;
	let matched = false;
	const unitSeconds: Record<string, number> = {
		day: 86400,
		days: 86400,
		hour: 3600,
		hours: 3600,
		minute: 60,
		minutes: 60,
		second: 1,
		seconds: 1,
	};

	for (const part of text.split(" ")) {
		const pair = /^(-?\d+(?:\.\d+)?)(day|days|hour|hours|minute|minutes|second|seconds)?$/.exec(part);
		if (pair) {
			total += Number(pair[1]) * (pair[2] ? unitSeconds[pair[2]] : 1);
			matched = true;
			continue;
		}
		const clock = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(part);
		if (clock) {
			const sign = clock[1] ? -1 : 1;
			total += sign * (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]));
			matched = true;
		}
	}

	return matched ? total : null;
}

/** Selisih dua waktu dalam detik (positif = `later` lebih baru). */
export function diffSeconds(later: unknown, earlier: unknown): number | null {
	const a = later instanceof Date ? later : new Date(String(later));
	const b = earlier instanceof Date ? earlier : new Date(String(earlier));
	if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
	return (a.getTime() - b.getTime()) / 1000;
}
