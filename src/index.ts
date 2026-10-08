/**
 * worker-toko — API toko game.
 *
 * Entry point. Isinya sengaja TIPIS: mencocokkan rute, menegakkan gerbang
 * token, lalu menyerahkan pekerjaan ke modul di src/routes/.
 * Aturan mainnya ada di src/lib/types.ts.
 *
 * Isi folder:
 *   src/config.ts        nama tabel, batas limit, header token
 *   src/lib/db.ts        koneksi Postgres + catatan soal enkripsi
 *   src/lib/http.ts      json/fail, scrub, perbandingan token
 *   src/lib/params.ts    pembaca angka query string
 *   src/lib/types.ts     kontrak rute (prepare/handle)
 *   src/shape.ts         bentuk JSON gabungan game + asset
 *   src/routes/          satu file per rute
 *
 * ============================================================================
 * BENTUK DATA (hasil periksa information_schema + pg_constraint)
 * ============================================================================
 * game_list   : id, game_id (UNIQUE), game_name, description, genre, tags,
 *               category, created_at, updated_at
 * game_asset  : game_id (PRIMARY KEY), lua_data, metadata, encyription [sic],
 *               created_at, updated_at
 *
 * CATATAN: kolom `previev_url_img` PERNAH ada di game_list (tertulis salah
 * ketik di DB) dan sudah dihapus dari skema. Kalau nanti dipasang lagi,
 * tambahkan kembali ke SELECT di src/routes/games-list.ts + pembentuk respons
 * di src/shape.ts. (games-detail.ts sudah TIDAK membaca database — sumbernya
 * Steam Store, lihat src/lib/steam.ts.)
 *
 * game_asset.game_id adalah PRIMARY KEY sekaligus FOREIGN KEY ke
 * game_list(game_id) ON DELETE CASCADE.
 *   => Relasinya 1 : 1 (satu game paling banyak punya SATU asset).
 *   => LEFT JOIN tidak akan pernah menggandakan baris game_list.
 * Sebagian besar baris asset, `metadata` ±7 KB dan berisi JSON (Steam app
 * manifest). `lua_data` contoh isinya "{}" dan `encyription` masih kosong.
 */

import { createDb } from "./lib/db";
import { checkWriteToken, fail, json, scrub } from "./lib/http";
import { resolveAuthSecret } from "./lib/auth";
import type { RouteDef, RouteContext } from "./lib/types";
import { healthRoute } from "./routes/health";
import { inspectRoute } from "./routes/inspect";
import { gamesListRoute } from "./routes/games-list";
import { gamesDetailRoute } from "./routes/games-detail";
import { authLoginRoute } from "./routes/auth-login";
import { authVerifyRoute } from "./routes/auth-verify";
import { authResendOtpRoute } from "./routes/auth-resend-otp";
import { authMachineRoute } from "./routes/auth-machine";
import { authMeRoute } from "./routes/auth-me";
import { authLogoutRoute } from "./routes/auth-logout";
import { authRecoveryRoute } from "./routes/auth-recovery";
import { claimInvoiceRoute } from "./routes/claim-invoice";
import { claimGameRoute } from "./routes/claim-game";
import { accountRoute } from "./routes/account";
import { claimStatusRoute } from "./routes/claim-status";
import { curatedRoute } from "./routes/curated";
import { consumeAssetJob, type AssetMessage } from "./lib/asset-jobs";
import { consumeFixesJob, type FixesMessage } from "./lib/fixes-jobs";
import { fixesRoutes } from "./routes/fixes";

/**
 * TABEL RUTE — satu-satunya daftar rute.
 *
 * Menambah rute baru: buat file di src/routes/, ekspor objeknya, lalu daftarkan
 * di sini. Urutan penting: rute berparameter (`/api/games/:game_id`) harus
 * berada SETELAH rute statis supaya tidak menelan jalur statis yang mirip.
 *
 * Rute auth sengaja bertoken `none` — yang menjaga mereka bukan write token,
 * melainkan pemeriksaan sesi di dalam rutenya sendiri (lib/session-guard.ts).
 * Write token tetap dipakai untuk rute yang menyentuh data mentah / menulis
 * tabel game.
 */
const ROUTES: RouteDef[] = [
	healthRoute(() => routeList()),
	inspectRoute,
	gamesListRoute,
	gamesDetailRoute,
	// --- auth: urutan tidak masalah, semuanya jalur statis -------------------
	authLoginRoute,
	authVerifyRoute,
	authResendOtpRoute,
	authMachineRoute,
	authMeRoute,
	authLogoutRoute,
	authRecoveryRoute,
	// --- claim invoice: jalur statis, sesi dijaga di dalam rutenya -----------
	claimInvoiceRoute,
	// --- claim game: jalur statis, sesi dijaga di dalam rutenya -------------
	claimGameRoute,
	claimStatusRoute,
	curatedRoute,
	...fixesRoutes,
	// --- account: satu GET untuk halaman Account FE (profil + owned + history)
	accountRoute,
];

/** Daftar rute untuk laporan GET /api/health. */
export function routeList(): string[] {
	return ROUTES.map((route) => `${route.method} ${route.path}`);
}

/** Cocokkan method + jalur, sekaligus tangkap parameternya. */
function matchRoute(
	route: RouteDef,
	method: string,
	path: string,
): readonly string[] | null {
	if (route.method !== method) return null;

	const pattern = route.pattern ?? new RegExp(`^${route.path}$`);
	const match = pattern.exec(path);
	if (!match) return null;
	return match.slice(1);
}

export default {
	async queue(batch: MessageBatch<AssetMessage | FixesMessage>, env: Env): Promise<void> {
		for (const message of batch.messages) {
            if (!message.body || typeof message.body !== "object") { message.ack(); continue; }
            if ("kind" in message.body && message.body.kind === "fixes") {
                const body = message.body;
                if (typeof body.fixId !== "string" || !body.fixId || body.fixId.length > 160 || !/^[a-f0-9]{64}$/.test(body.revision) || !["manifest","fix"].includes(body.slot) || !/^[a-f0-9-]{36}$/.test(body.requestToken)) { message.ack(); continue; }
                try { const result = await consumeFixesJob(body, env); if (result === "busy") message.retry({delaySeconds:300}); else message.ack(); }
                catch { message.retry({delaySeconds:60}); }
                continue;
            }

			if (!Number.isSafeInteger((message.body as AssetMessage)?.gameId) || (message.body as AssetMessage).gameId <= 0 || !/^[a-f\d-]{36}$/i.test(message.body.requestToken ?? "")) { message.ack(); continue; }
			try {
				const result = await consumeAssetJob(message.body as AssetMessage, env);
				if (result === "busy") message.retry({ delaySeconds: 300 }); else message.ack();
			} catch { message.retry({ delaySeconds: 60 }); }
		}
	},
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// ------------------------------------------------------------------
		// 1. Cocokkan rute. Rute tak dikenal ditolak di sini — belum ada
		//    koneksi database yang dibuka.
		// ------------------------------------------------------------------
		let route: RouteDef | undefined;
		let params: readonly string[] = [];
		for (const candidate of ROUTES) {
			const captured = matchRoute(candidate, request.method, path);
			if (captured) {
				route = candidate;
				params = captured;
				break;
			}
		}

		if (!route) {
			return fail(404, `Rute tidak dikenal: ${request.method} ${path}`);
		}

		const context: RouteContext = { request, env, executionCtx: ctx, url, params };

		// ------------------------------------------------------------------
		// 1b. Peringatan konfigurasi: rute auth menandatangani token dengan
		//     AUTH_SECRET. Kalau secret aslinya belum dipasang, nilainya masih
		//     bawaan pengembangan — dicatat di log supaya tidak diam-diam ikut
		//     ke produksi (health juga melaporkannya).
		// ------------------------------------------------------------------
		if (path.startsWith("/api/auth/") && resolveAuthSecret(env).temporary) {
			console.warn(
				"[auth] AUTH_SECRET belum di-set; token ditandatangani nilai pengembangan. Jalankan: wrangler secret put AUTH_SECRET",
			);
		}

		// ------------------------------------------------------------------
		// 2. Gerbang token: rute yang membuka data mentah (inspect) maupun
		//    yang menulis wajib membawa write token yang sah.
		// ------------------------------------------------------------------
		if (route.token === "write") {
			const status = checkWriteToken(request, env);
			if (status === "not-configured") {
				return fail(503, "WRITE_TOKEN belum di-set di server.");
			}
			if (status === "mismatch") {
				return fail(401, "Token tulis tidak sah.");
			}
		}

		try {
			// ----------------------------------------------------------------
			// 3. VALIDASI MASUKAN lebih dulu. Semua penolakan terjadi SEBELUM
			//    koneksi database dibuat, supaya permintaan ngawur tidak
			//    membebani DB sama sekali.
			// ----------------------------------------------------------------
			const input = route.prepare ? await route.prepare(context) : { input: undefined };
			if (input instanceof Response) return input;

			// ----------------------------------------------------------------
			// 4. Jalankan. Rute yang butuh DB baru membuka koneksi di sini.
			// ----------------------------------------------------------------
			if (!route.requiresDb) {
				return await route.handle(context, input.input);
			}

			if (!env.DIRECT_URL) {
				return fail(
					500,
					"Secret DIRECT_URL belum di-set. Jalankan: wrangler secret put DIRECT_URL",
				);
			}

			const sql = createDb(env);
			try {
				return await route.handle(context, input.input, sql);
			} finally {
				// waitUntil, BUKAN await: jangan menahan respons sampai
				// koneksi tutup.
				ctx.waitUntil(sql.end({ timeout: 5 }));
			}
		} catch (err) {
			// Pesan sudah disensor, jadi aman dikirim keluar.
			return json({ ok: false, error: scrub(err) }, 500);
		}
	},
} satisfies ExportedHandler<Env, AssetMessage | FixesMessage>;
