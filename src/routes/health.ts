/**
 * GET /api/health — status Worker. Tidak menyentuh database.
 *
 * Cocok untuk memastikan Worker hidup dan secret sudah terpasang, tanpa
 * membuka koneksi apa pun.
 *
 * Dibuat sebagai "factory" karena perlu ikut melaporkan daftar rute: daftarnya
 * tinggal satu tempat, yaitu tabel ROUTES di index.ts. index.ts menyerahkan
 * pembacanya lewat parameter, jadi tidak ada saling-import antar file.
 */

import { DB_ENCRYPTED, DB_MODE, WORKER_NAME } from "../config";
import { json } from "../lib/http";
import type { PlainRoute } from "../lib/types";

export function healthRoute(listRoutes: () => string[]): PlainRoute {
	return {
		method: "GET",
		path: "/api/health",
		token: "none",
		requiresDb: false,
		handle: (ctx) =>
			json({
				ok: true,
				worker: WORKER_NAME,
				db: DB_MODE,
				encrypted: DB_ENCRYPTED,
				routes: listRoutes(),
				directUrlConfigured: Boolean(ctx.env.DIRECT_URL),
				writeTokenConfigured: Boolean(ctx.env.WRITE_TOKEN),
			}),
	};
}
