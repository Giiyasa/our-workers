/**
 * Perkakas HTTP yang dipakai semua rute.
 */

import { ACCESS_TOKEN_ERRORS, readAccessToken, resolveAuthSecret } from "./auth";
import type { AccessTokenInfo } from "./auth";
import { ACCESS_TOKEN_HEADER, WRITE_TOKEN_HEADER } from "../config";

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/**
 * Balasan penolakan standar, dipakai di fase validasi (prepare) maupun di
 * dalam `handle`.
 *
 * `code` opsional: dipakai frontend untuk membedakan sebab penolakan tanpa
 * harus mencocokkan teks pesannya (yang bisa berubah kapan saja).
 */
export function fail(status: number, error: string, code?: string): Response {
	const body: Record<string, unknown> = { ok: false, error };
	if (code) body.code = code;
	return json(body, status);
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

export type AccessStatus =
	| { ok: true; info: AccessTokenInfo }
	| { ok: false; status: number; error: string };

/**
 * Periksa header `X-Access-Token` untuk rute yang butuh sesi login.
 *
 * Rute memanggil ini di `prepare()` — jadi token yang tidak sah ditolak
 * SEBELUM koneksi database dibuka. Di sini yang diperiksa baru "token asli,
 * ditandatangani Worker, dan belum lewat masa berlakunya". Pencocokan dengan
 * baris user (catatan sesi di `machine_info`, sidik jari kredensial) dikerjakan
 * `requireSession()` di lib/session-guard.ts, karena butuh query.
 */
export function checkAccessToken(request: Request, env: Env): AccessStatus {
	const token = request.headers.get(ACCESS_TOKEN_HEADER);
	const { secret } = resolveAuthSecret(env);
	const result = readAccessToken(token, secret);
	if (!result.ok) {
		return { ok: false, status: 401, error: ACCESS_TOKEN_ERRORS[result.reason] };
	}
	return { ok: true, info: result.info };
}
