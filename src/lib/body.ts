/**
 * Pembaca body JSON.
 *
 * Dipakai rute POST. Pemisahannya dari aturan bisnis disengaja: rute cuma
 * minta "berikan saya objek JSON", dan semua bentuk penolakan (body kosong,
 * bukan JSON, kepanjangan) terjadi di sini — sebelum koneksi database dibuka.
 */

import { MAX_BODY_BYTES } from "../config";
import { fail } from "./http";

/**
 * Baca body sebagai objek JSON.
 *
 * Mengembalikan `Response` kalau ditolak — jadi rute bisa menuliskannya
 * sebagai nilai balik `prepare()` tanpa try/catch tambahan:
 *
 *     const parsed = await readJsonBody(request);
 *     if (parsed instanceof Response) return parsed;
 */
export async function readJsonBody(
	request: Request,
): Promise<Response | { value: Record<string, unknown> }> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		return fail(413, `Body terlalu besar (maksimum ${MAX_BODY_BYTES} byte).`);
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return fail(400, "Body permintaan tidak bisa dibaca.");
	}

	if (text.length > MAX_BODY_BYTES) {
		return fail(413, `Body terlalu besar (maksimum ${MAX_BODY_BYTES} byte).`);
	}
	if (!text.trim()) {
		return fail(400, "Body permintaan kosong; kirim JSON.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail(400, "Body bukan JSON yang sah.");
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(400, "Body harus berupa objek JSON.");
	}

	return { value: parsed as Record<string, unknown> };
}

/** Ambil field teks dari body, sudah dirapikan (trim). */
export function stringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === "string" ? value.trim() : "";
}

/** Ambil field apa pun sebagai teks mentah (untuk `machine_info` JSON). */
export function rawField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

/**
 * Ambil jumlah detik dari body (mis. `token_ttl_s`).
 * Nilai tak wajar = memakai `fallback`, bukan menolak permintaan.
 */
export function secondsField(
	body: Record<string, unknown>,
	key: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = body[key];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.min(Math.max(Math.trunc(raw), min), max);
}
