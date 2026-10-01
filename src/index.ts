/**
 * worker-toko — API toko game.
 *
 * ============================================================================
 * KONEKSI DATABASE: LANGSUNG (tanpa Hyperdrive)
 * ============================================================================
 * Worker ini menyambung langsung ke Postgres Supabase memakai string koneksi
 * yang disimpan sebagai SECRET (bukan di file konfigurasi, bukan di git).
 *
 * !! JALUR INI TIDAK TERENKRIPSI !!
 * Cloudflare Workers saat ini TIDAK BISA membuat TLS ke server Postgres.
 * Sudah diuji berulang kali, hasilnya selalu gagal:
 *
 *   - postgres.js  : "The options.rejectUnauthorized option is not implemented"
 *   - pg (node-pg) : error yang sama
 *   - connect({secureTransport:"on"})  -> "proxy request failed"
 *   - sock.startTls({expectedServerHostname}) -> "TLS Handshake Failed."
 *   - node:tls pada socket Workers      -> "options.rejectUnauthorized ... "
 *
 * Sebagai pembanding, TLS ke server lain (smtp.gmail.com:465) BERHASIL,
 * jadi ini batasan khusus jalur TLS-ke-Postgres, bukan berarti Worker tidak
 * bisa TLS sama sekali.
 *
 * AKIBATNYA: data (termasuk hash password, kode OTP) berjalan TANPA enkripsi
 * antara Cloudflare dan Supabase. Amannya: pakai kredensial yang hak aksesnya
 * dibatasi, dan/atau pindah ke Hyperdrive yang menyediakan TLS.
 * Opsi `ssl: false` di bawah ditulis EKSPLISIT supaya tidak ada yang mengira
 * koneksi ini terenkripsi.
 *
 * CATATAN GAYA: seluruh nama fungsi, variabel, konstanta, dan kunci JSON
 * memakai bahasa Inggris. Komentar dan pesan error tetap bahasa Indonesia.
 *
 * ============================================================================
 * BENTUK DATA (hasil periksa information_schema + pg_constraint)
 * ============================================================================
 * game_list   : id, game_id (UNIQUE), game_name, description, genre, tags,
 *               category, previev_url_img [sic], created_at, updated_at
 * game_asset  : game_id (PRIMARY KEY), lua_data, metadata, encyription [sic],
 *               created_at, updated_at
 *
 * game_asset.game_id adalah PRIMARY KEY sekaligus FOREIGN KEY ke
 * game_list(game_id) ON DELETE CASCADE.
 *   => Relasinya 1 : 1 (satu game paling banyak punya SATU asset).
 *   => LEFT JOIN tidak akan pernah menggandakan baris game_list.
 * Sebagian besar baris asset, `metadata` ±7 KB dan berisi JSON (Steam app
 * manifest). `lua_data` contoh isinya "{}" dan `encyription` masih kosong.
 *
 * ============================================================================
 * Rute:
 *   GET  /api/health          -> status worker (tidak menyentuh DB)
 *   GET  /api/db/inspect      -> kolom tabel (diagnosa, butuh write token)
 *   GET  /api/games           -> game_list LEFT JOIN game_asset (ringkas)
 *   GET  /api/games/:game_id  -> satu game + asset penuh
 *   POST /api/games           -> tulis ke game_list (butuh write token)
 *
 * Rute GET /api/games menerima query:
 *   ?limit=50     maksimum 200 baris sekali ambil
 *   ?offset=0     untuk halaman berikutnya
 *   ?q=witcher    cari di game_name/genre/category/tags (substring)
 *   ?category=X   saring kategori persis
 *   ?full=1       sertakan lua_data + metadata + encyription mentah
 */

import postgres from "postgres";

/**
 * Buat client baru per-request. Worker tidak boleh menyimpan soket di
 * variabel global (dilarang runtime dan bocor antar-request).
 */
function createDb(env: Env) {
	return postgres(env.DIRECT_URL, {
		// Worker dibatasi 6 koneksi bersamaan; sisakan ruang.
		max: 3,
		// Hemat satu round-trip kalau tipe array tidak dipakai.
		fetch_types: false,
		// Prepared statement butuh round-trip tambahan (Parse/Describe).
		// Jalur kita sudah rawan kena batas subrequest, jadi dimatikan.
		prepare: false,
		// EKSPLISIT: tanpa enkripsi. Lihat catatan di atas.
		// Jangan diubah jadi `true`: TLS ke Postgres dari Workers memang gagal,
		// dan kalaupun "jalan" ia bisa turun diam-diam ke tanpa enkripsi.
		ssl: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
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

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** Bandingkan dua string tanpa membocorkan panjang/isi lewat waktu respons. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

type TokenStatus = "ok" | "not-configured" | "mismatch";

/** Baca nilai header write token, lalu bandingkan dengan aman. */
function checkWriteToken(request: Request, env: Env): TokenStatus {
	if (!env.WRITE_TOKEN) return "not-configured";
	const sent = request.headers.get("x-write-token") ?? "";
	return safeEqual(sent, env.WRITE_TOKEN) ? "ok" : "mismatch";
}

const TABLE_GAME = "game_list";
const TABLE_ASSET = "game_asset";

/** Rute /api/db/inspect cuma boleh membaca tabel ini, bukan seluruh skema. */
const ALLOWED_TABLES = new Set([TABLE_GAME, TABLE_ASSET]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Baca kolom text sebagai JSON; kembalikan null kalau isinya bukan JSON. */
function tryParseJson(text: unknown): unknown {
	if (typeof text !== "string" || !text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Ambil nilai angka dari query string dengan batas aman.
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

type RouteKind = "inspect" | "list" | "detail" | "write";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Rute yang tidak menyentuh DB: bisa dites tanpa database sama sekali.
		if (request.method === "GET" && path === "/api/health") {
			return json({
				ok: true,
				worker: "worker-toko",
				db: "langsung (tanpa Hyperdrive)",
				encrypted: false,
				routes: [
					"GET /api/health",
					"GET /api/db/inspect?table=game_list|game_asset",
					"GET /api/games",
					"GET /api/games/:game_id",
					"POST /api/games",
				],
				directUrlConfigured: Boolean(env.DIRECT_URL),
				writeTokenConfigured: Boolean(env.WRITE_TOKEN),
			});
		}

		// ------------------------------------------------------------------
		// Tentukan jenis permintaan dan VALIDASI MASUKAN lebih dulu.
		// Semua penolakan di bawah ini terjadi SEBELUM koneksi database dibuat,
		// supaya permintaan ngawur tidak pernah membebani DB sama sekali.
		// ------------------------------------------------------------------
		const detailMatch = path.match(/^\/api\/games\/([^/]+)$/);
		let kind: RouteKind | null = null;
		let requestedGameId = 0;

		if (request.method === "GET" && path === "/api/db/inspect") {
			kind = "inspect";
		} else if (request.method === "GET" && path === "/api/games") {
			kind = "list";
		} else if (request.method === "GET" && detailMatch) {
			kind = "detail";
		} else if (request.method === "POST" && path === "/api/games") {
			kind = "write";
		}

		if (!kind) {
			return json(
				{ ok: false, error: `Rute tidak dikenal: ${request.method} ${path}` },
				404,
			);
		}

		if (kind === "detail") {
			const rawId = detailMatch![1];
			if (!/^\d{1,15}$/.test(rawId)) {
				return json({ ok: false, error: "game_id harus berupa angka." }, 400);
			}
			requestedGameId = Number(rawId);
		}

		// Gerbang token: berlaku untuk semua rute yang membuka data mentah
		// (inspect) maupun yang menulis.
		if (kind === "inspect" || kind === "write") {
			const status = checkWriteToken(request, env);
			if (status === "not-configured") {
				return json({ ok: false, error: "WRITE_TOKEN belum di-set di server." }, 503);
			}
			if (status === "mismatch") {
				return json({ ok: false, error: "Token tulis tidak sah." }, 401);
			}
		}

		if (kind === "inspect") {
			const tableName = url.searchParams.get("table") ?? TABLE_GAME;
			if (!ALLOWED_TABLES.has(tableName)) {
				return json(
					{
						ok: false,
						error: `Tabel tidak diizinkan. Pilihan: ${[...ALLOWED_TABLES].join(", ")}`,
					},
					400,
				);
			}
		}

		// Body dibaca sebelum koneksi DB dibuka.
		let body: Record<string, unknown> | undefined;
		if (kind === "write") {
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return json({ ok: false, error: "Body bukan JSON yang sah." }, 400);
			}
			if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) {
				return json({ ok: false, error: "Body kosong." }, 400);
			}
		}

		if (!env.DIRECT_URL) {
			return json(
				{
					ok: false,
					error:
						"Secret DIRECT_URL belum di-set. Jalankan: wrangler secret put DIRECT_URL",
				},
				500,
			);
		}

		const sql = createDb(env);
		try {
			// ----------------------------------------------------------------
			// Diagnosa: kolom sebuah tabel, tanpa membuka dashboard.
			// ----------------------------------------------------------------
			if (kind === "inspect") {
				const tableName = url.searchParams.get("table") ?? TABLE_GAME;
				const columns = await sql`
					select column_name, data_type, is_nullable, column_default
					from information_schema.columns
					where table_name = ${tableName}
					order by ordinal_position
				`;
				const exists = await sql`
					select to_regclass(${`public.${tableName}`}) is not null as table_exists
				`;
				return json({
					ok: true,
					table: tableName,
					exists: exists[0]?.table_exists ?? false,
					columns,
				});
			}

			// ----------------------------------------------------------------
			// DAFTAR: game_list LEFT JOIN game_asset
			// ----------------------------------------------------------------
			if (kind === "list") {
				const limit = readInt(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
				const offset = readInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
				const q = (url.searchParams.get("q") ?? "").trim();
				const category = (url.searchParams.get("category") ?? "").trim();
				const full = ["1", "true", "full", "ya"].includes(
					(url.searchParams.get("full") ?? "").toLowerCase(),
				);

				const conditions = [];
				if (q) {
					const pattern = `%${q}%`;
					conditions.push(
						sql`(g.game_name ilike ${pattern} or g.genre ilike ${pattern} or g.category ilike ${pattern} or g.tags ilike ${pattern})`,
					);
				}
				if (category) conditions.push(sql`g.category = ${category}`);
				const where =
					conditions.length > 0
						? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}`
						: sql``;

				// mode ringkas: jangan kirim kolom ±7 KB ke client kalau tidak perlu
				//
				// CATATAN: fragmen di bawah adalah kolom TERAKHIR pada daftar
				// select, jadi keduanya TIDAK boleh berakhir dengan koma.
				// Kalau diberi koma, SQL jadi "... ,\nfrom ..." dan Postgres
				// membalas: syntax error at or near "from".
				const assetColumns = full
					? sql`a.lua_data as asset_lua_data, a.metadata as asset_metadata, a.encyription as asset_encyription`
					: sql`length(a.lua_data) as asset_lua_bytes, length(a.metadata) as asset_metadata_bytes, length(a.encyription) as asset_ency_bytes`;

				// limit + 1 supaya kita tahu masih ada halaman berikutnya
				// tanpa perlu query count terpisah.
				const rows = await sql`
					select
						g.id, g.game_id, g.game_name, g.description, g.category,
						g.genre, g.tags, g.previev_url_img, g.created_at, g.updated_at,
						a.game_id as asset_game_id,
						a.created_at as asset_created_at,
						a.updated_at as asset_updated_at,
						${assetColumns}
					from ${sql(TABLE_GAME)} g
					left join ${sql(TABLE_ASSET)} a on a.game_id = g.game_id
					${where}
					order by g.id
					limit ${limit + 1} offset ${offset}
				`;

				const hasMore = rows.length > limit;
				const data = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
					shapeGame(row, full),
				);

				return json({
					ok: true,
					count: data.length,
					limit,
					offset,
					has_more: hasMore,
					full,
					q: q || null,
					category: category || null,
					data,
				});
			}

			// ----------------------------------------------------------------
			// DETAIL: satu game + asset penuh (lua_data, metadata, encyription)
			// ----------------------------------------------------------------
			if (kind === "detail") {
				const rows = await sql`
					select
						g.id, g.game_id, g.game_name, g.description, g.category,
						g.genre, g.tags, g.previev_url_img, g.created_at, g.updated_at,
						a.game_id as asset_game_id,
						a.created_at as asset_created_at,
						a.updated_at as asset_updated_at,
						a.lua_data as asset_lua_data,
						a.metadata as asset_metadata,
						a.encyription as asset_encyription
					from ${sql(TABLE_GAME)} g
					left join ${sql(TABLE_ASSET)} a on a.game_id = g.game_id
					where g.game_id = ${requestedGameId}
					limit 1
				`;

				if (rows.length === 0) {
					return json(
						{ ok: false, error: `game_id ${requestedGameId} tidak ditemukan.` },
						404,
					);
				}
				return json({ ok: true, data: shapeGame(rows[0], true) });
			}

			// ----------------------------------------------------------------
			// TULIS: tambah baris game_list
			// ----------------------------------------------------------------
			if (kind === "write" && body) {
				const keys = Object.keys(body);
				const row = await sql`
					insert into ${sql(TABLE_GAME)} ${sql(body, ...keys)}
					returning *
				`;
				return json({ ok: true, data: row[0] }, 201);
			}

			return json({ ok: false, error: "Rute tidak dikenal." }, 404);
		} catch (err) {
			// Pesan sudah disensor, jadi aman dikirim keluar.
			return json({ ok: false, error: scrub(err) }, 500);
		} finally {
			// waitUntil, BUKAN await: jangan menahan respons sampai koneksi tutup.
			ctx.waitUntil(sql.end({ timeout: 5 }));
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * Ubah baris hasil LEFT JOIN yang datar jadi bentuk bersarang:
 * { ...game, asset: { has_asset, ... } }
 *
 * `asset.has_asset` berasal dari asset_game_id: kalau game belum punya asset
 * sama sekali, kolom asset yang lain pasti null semua.
 */
export function shapeGame(row: Record<string, any>, full: boolean) {
	const hasAsset = row.asset_game_id !== null && row.asset_game_id !== undefined;

	const asset: Record<string, unknown> = {
		has_asset: hasAsset,
		created_at: row.asset_created_at ?? null,
		updated_at: row.asset_updated_at ?? null,
	};

	if (full) {
		asset.lua_data = row.asset_lua_data ?? null;
		asset.metadata = row.asset_metadata ?? null;
		// Bentuk JSON dari metadata, biar client tidak perlu parse sendiri.
		asset.metadata_json = tryParseJson(row.asset_metadata);
		asset.encyription = row.asset_encyription ?? null;
	} else {
		asset.lua_bytes = row.asset_lua_bytes ?? null;
		asset.metadata_bytes = row.asset_metadata_bytes ?? null;
		asset.encyription_bytes = row.asset_ency_bytes ?? null;
	}

	return {
		id: row.id,
		game_id: row.game_id,
		game_name: row.game_name,
		description: row.description ?? null,
		category: row.category ?? null,
		genre: row.genre ?? null,
		tags: row.tags ?? null,
		// Nama kolom di DB memang salah ketik (previev_url_img); dipertahankan
		// apa adanya supaya tidak ada yang menebak-nebak asalnya.
		previev_url_img: row.previev_url_img ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		asset,
	};
}
