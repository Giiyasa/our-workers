/**
 * Perkakas HTTP yang dipakai semua rute.
 */

import { WRITE_TOKEN_HEADER } from "../config";

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** Balasan penolakan standar, dipakai di fase validasi (prepare). */
export function fail(status: number, error: string): Response {
	return json({ ok: false, error }, status);
}

/**
 * Bersihkan pesan error sebelum dikirim ke pemanggil.
 * Driver database gemar menempelkan connection string (lengkap dengan
 * password) ke dalam pesan error. Kalau lolos, rahasia itu bocor lewat
 * respons HTTP.
 */
const SECRET_PATTERNS: RegExp[] = [
	/postgres(?:ql)?:\/\/\S+/gi, // connection string
	/sb_secret_[A-Za-z0-9_-]+/g, // secret key gaya baru
	/sb_publishable_[A-Za-z0-9_-]+/g, // publishable key gaya baru
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT lama
];

export function scrub(input: unknown): string {
	const text =
		input instanceof Error ? `${input.name}: ${input.message}` : String(input);
	return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[RAHASIA DISENSOR]"), text);
}

/** Bandingkan dua string tanpa membocorkan panjang/isi lewat waktu respons. */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export type TokenStatus = "ok" | "not-configured" | "mismatch";

/** Baca nilai header write token, lalu bandingkan dengan aman. */
export function checkWriteToken(request: Request, env: Env): TokenStatus {
	if (!env.WRITE_TOKEN) return "not-configured";
	const sent = request.headers.get(WRITE_TOKEN_HEADER) ?? "";
	return safeEqual(sent, env.WRITE_TOKEN) ? "ok" : "mismatch";
}
