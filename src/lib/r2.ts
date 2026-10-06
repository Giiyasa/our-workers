/**
 * Klien Cloudflare R2 (S3 API) untuk rute claim-game.
 *
 * File .lua disimpan di bucket R2 — KREDENSIAL BUKAN BINDING: endpoint R2
 * ("bucket di path") hanya menerima SigV4 yang host-nya endpoint itu sendiri,
 * jadi binding wrangler R2Buckets (host acak, bucket via binding) selalu
 * 404/NoSuchBucket — sudah dicoba dan gagal di produksi. Request disign manual
 * pakai S3 SigV4 (AWS Signature Version 4): header Authorization,
 * x-amz-content-sha256: UNSIGNED-PAYLOAD, dan x-amz-date DITANDATANGANI.
 *
 * Yang dipakai claim-game cuma presigned-GET-style: worker menghasilkan
 * URL bertanda tangan untuk SATU metode (GET)KE satu objek, lalu fetch URL itu.
 * Konstraint Workers: fetch() WAJIB alamat absolut; menggabungkan fetch dengan
 * Authorization header manual pada URL path berparameter TIDAK dijamin — jadi
 * SEMUA (auth, content-sha256, date) ikut di-QUERY STRING, bentuk yang sah
 * menurut spesifikasi S3 ("presigned URL", expiry di X-Amz-Expires).
 *
 * Worker TIDAK memegang rahasia apa pun di request database: kredensial ini
 * murni worker <-> R2, tidak pernah dikirim ke client.
 */

import { R2_PRESIGN_TTL_S, STEAM_MAX_APP_ID } from "../config";
import { readLua } from "./asset-providers";

/** Bagian konfigurasi R2, dipisah agar mudah diuji (fungsi murni di bawah). */
export interface R2Config {
	accessKeyId: string;
	secretAccessKey: string;
	/** Host endpoint R2, mis. "<account>.r2.cloudflarestorage.com" */
	host: string;
	bucket: string;
}

/**
 * Ambil konfigurasi R2 dari Env. Nilai boleh kosong — pemanggil (rute)
 * yang memutuskan reaksinya (503), jadi gerbang konfigurasi tetap satu pola
 * dengan DIRECT_URL/WRITE_TOKEN: hilang = ditolak dengan jelas, bukan gagal
 * di tengah signature.
 */
export function readR2Config(env: Env): R2Config | null {
	const host = (env.R2_ENDPOINT ?? "")
		.trim()
		// terima bentuk dengan atau tanpa skema; buang "https://" / "http://"
		.replace(/^https?:\/\//i, "")
		// buang slash di ujung sehingga "https://host/" dan "https://host" setara
		.replace(/\/+$/, "");
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !host || !env.R2_BUCKET) {
		return null;
	}
	return {
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		host,
		bucket: env.R2_BUCKET,
	};
}

/** Ganti karater dengan persamaan S3 URI-encode (RFC 3986, kecuali unreserved). */
function s3UriEncode(value: string): string {
	// encodeURIComponent mendekati tapi tidak persis: karakter "!'()*" harus
	// ikut di-encode menurut S3, dan spasi harus %20 (bukan +).
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

/** HMAC-SHA256 di runtime Workers: SubtleCrypto (tanpa byte key pendek). */
async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key instanceof Uint8Array ? key : new Uint8Array(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
	return new Uint8Array(signature);
}

async function sha256Hex(message: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Key objek R2 untuk appid tertentu — SATU tempat, supaya penamaan bucket
 * ("lua/<appid>.lua") tidak tersebar.
 *
 * `appid` dijamin angka oleh pemanggil (rute memvalidasinya di prepare()).
 * Pemeriksaan tetap disini sebagai pagar terakhir bentuk key yang dihasilkan.
 */
export function luaObjectKey(appId: number): string {
	if (!Number.isInteger(appId) || appId <= 0 || appId > STEAM_MAX_APP_ID) {
		throw new Error(`appid di luar rentang: ${appId}`);
	}
	return `lua/${appId}.lua`;
}

/**
 * Buat presigned URL GET untuk SATU objek bucket.
 *
 * Semua query param wajib URLENCODED + SORTED di canonical query (X-Amz-
 * Signature dihitung dari daftar yang sudah ter-encode itu). Kesalahan lama
 * yang sudah pernah kena di CLI: token continuation dengan "/" di dalamnya
 * di-encode di URL tapi tidak di canonical — jangan diulang.
 */
export async function presignR2Get(
	config: R2Config,
	key: string,
	expiresSeconds: number,
	method: "GET" | "PUT" = "GET",
): Promise<string> {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"; // 20261005T073354Z
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/auto/s3/aws4_request`;
	const credential = `${config.accessKeyId}/${scope}`;

	const query = new Map<string, string>([
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", credential],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(Math.max(60, Math.min(expiresSeconds, 604_800)))],
		["X-Amz-SignedHeaders", "host"],
	]);

	// Canonical query string: sort by KEY LALU VALUE, semua URI-encoded.
	const canonicalQuery = [...query.entries()]
		.map(([k, v]) => [s3UriEncode(k), s3UriEncode(v)] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");

	// Canonical URI: bucket + key DENGAN SLASH LITERAL — R2 (beda perilaku
	// dengan AWS S3) mendekode path sebelum menghitung canonical request;
	// key ter-encode %2F menghasilkan SignatureDoesNotMatch (terbukti dari
	// CanonicalRequestBytes yang R2 kirim balik saat 403). Key kita hanya
	// berisi [a-z0-9/.] sehingga aman tanpa encoding tambahan.
	const canonicalUri = `/${config.bucket}/${key}`;
	const canonicalRequest = [
		method,
		canonicalUri,
		canonicalQuery,
		`host:${config.host}`,
		"", // signed headers: hanya host (dipisah \n)
		"host",
		"UNSIGNED-PAYLOAD",
	].join("\n");

	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		await sha256Hex(canonicalRequest),
	].join("\n");

	// Derived signing key: HMAC("AWS4"+secret, date) -> region -> service -> "aws4_request"
	let signingKey = await hmacSha256(
		new TextEncoder().encode(`AWS4${config.secretAccessKey}`),
		dateStamp,
	);
	for (const part of ["auto", "s3", "aws4_request"]) {
		signingKey = await hmacSha256(signingKey, part);
	}
	const signature = toHex(await hmacSha256(signingKey, stringToSign));

	const finalQuery = `${canonicalQuery}&X-Amz-Signature=${s3UriEncode(signature)}`;
	return `https://${config.host}${canonicalUri}?${finalQuery}`;
}

/**
 * Ambil isi objek .lua dari R2. Mengembalikan:
 *   - { ok: true, bytes }             -> file siap diteruskan ke client
 *   - { ok: false, status, error }    -> 404 (tidak ada) / 502 (R2 tak bisa dihubungi)
 *
 * Timeout dan batas ukuran ditegakkan di sini supaya rute tidak menulis ulang.
 */
export async function fetchR2Lua(
	env: Env,
	appId: number,
	objectKey = luaObjectKey(appId),
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number; error: string }> {
	const config = readR2Config(env);
	if (!config) {
		console.error("r2_read_failed", { appId, stage: "configuration", reason: "missing_configuration" });
		return {
			ok: false,
			status: 503,
			error: "Kredensial R2 belum di-set di server (R2_*).",
		};
	}

	let stage = "signing";
	const startedAt = Date.now();
	let response: Response;
	try {
		const url = await presignR2Get(config, objectKey, R2_PRESIGN_TTL_S);
		stage = "fetch";
		response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
	} catch (error) {
		// Do not log error messages/stacks: fetch errors can contain signed URLs.
		console.error("r2_read_failed", {
			appId, stage, elapsedMs: Date.now() - startedAt,
			reason: error instanceof DOMException && error.name === "TimeoutError" ? "timeout"
				: error instanceof DOMException && error.name === "AbortError" ? "aborted"
				: error instanceof TypeError ? "type_or_network_error" : "unexpected_error",
		});
		throw error;
	}
	if (response.status === 404) {
		await response.body?.cancel();
		return { ok: false, status: 404, error: "File game ini belum tersedia di penyimpanan." };
	}
	if (!response.ok) {
		console.error("r2_read_failed", {
			appId, stage: "http", status: response.status, elapsedMs: Date.now() - startedAt,
		});
		await response.body?.cancel();
		return {
			ok: false,
			status: 502,
			error: "Penyimpanan file (R2) tidak bisa dihubungi.",
		};
	}

	// Batas ukuran: pengguna akhir tidak butuh file .lua gigabyte-an; kalau
	// lebih besar dari MAX_LUA_BYTES, hentikan (padahal isi realnya ±1KB).
	try {
		return { ok: true, bytes: await readLua(response) };
	} catch (error) {
		console.error("r2_read_failed", {
			appId, stage: "read_or_validate", status: response.status, elapsedMs: Date.now() - startedAt,
			reason: error instanceof TypeError ? "invalid_encoding_or_read_error" : "invalid_lua_or_read_error",
		});
		throw error;
	}
}

/** Unique object keys fence uploads from expired job owners. */
export async function uploadR2Lua(env: Env, objectKey: string, bytes: Uint8Array): Promise<void> {
	const config = readR2Config(env);
	if (!config) throw new Error("Kredensial R2 belum dikonfigurasi.");
	if (!/^lua\/[\d]+\/[a-f\d-]+\.lua$/i.test(objectKey)) throw new Error("Key objek tidak valid.");
	const url = await presignR2Get(config, objectKey, R2_PRESIGN_TTL_S, "PUT");
	const response = await fetch(url, {
		method: "PUT", body: bytes as Uint8Array<ArrayBuffer>,
		headers: { "content-type": "application/octet-stream" },
		signal: AbortSignal.timeout(8000), redirect: "error",
	});
	await response.body?.cancel();
	if (!response.ok) throw new Error("Upload file R2 gagal.");
}
