/**
 * Kontrak antara entry point (src/index.ts) dan modul-modul rute.
 *
 * Alur satu permintaan:
 *   1. index.ts mencocokkan rute (method + jalur / pola)
 *   2. gerbang token — khusus rute yang membuka data mentah atau menulis
 *   3. route.prepare()  — VALIDASI, belum menyentuh database
 *   4. koneksi DB dibuka (hanya kalau requiresDb)
 *   5. route.handle()   — pekerjaan sebenarnya
 *
 * Pemisahan prepare/handle itu disengaja: permintaan ngawur (game_id bukan
 * angka, body kosong, tabel tak diizinkan) ditolak di langkah 3, jadi
 * permintaan ngawur TIDAK PERNAH membebani database.
 */

import type { Sql } from "./db";

export type HttpMethod = "GET" | "POST";

/** Rute yang membuka data mentah atau menulis wajib membawa write token. */
export type TokenPolicy = "none" | "write";

export interface RouteContext {
	request: Request;
	env: Env;
	executionCtx: ExecutionContext;
	url: URL;
	/** Hasil tangkapan pola jalur. `[:game_id]` -> params[0] = "620". */
	params: readonly string[];
}

/** Hasil prepare(): input yang sudah divalidasi, ATAU Response penolakan. */
export type Prepared<P> = Response | { input: P };

interface RouteBase {
	method: HttpMethod;
	/**
	 * Jalur untuk manusia; boleh memuat parameter (`/api/games/:game_id`).
	 * Dipakai juga sebagai jalur pencocokan kalau `pattern` tidak diisi.
	 */
	path: string;
	/** Pola pencocokan jalur berparameter. Wajib pasangan dari `path`. */
	pattern?: RegExp;
	token: TokenPolicy;
}

export interface PlainRoute<P = unknown> extends RouteBase {
	requiresDb: false;
	prepare?: (ctx: RouteContext) => Prepared<P> | Promise<Prepared<P>>;
	handle: (ctx: RouteContext, input: P) => Response | Promise<Response>;
}

export interface DbRoute<P = unknown> extends RouteBase {
	requiresDb: true;
	prepare?: (ctx: RouteContext) => Prepared<P> | Promise<Prepared<P>>;
	handle: (
		ctx: RouteContext,
		input: P,
		sql: Sql,
	) => Response | Promise<Response>;
}

export type RouteDef = PlainRoute<any> | DbRoute<any>;
