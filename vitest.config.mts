import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// ---------------------------------------------------------------------------
// PENTING: `vitest-pool-workers` MEMUAT `.dev.vars` secara default.
//
// Kalau dibiarkan, variabel `DIRECT_URL` di `.dev.vars` ikut terbaca dan tes
// bisa menembak DATABASE SUNGGUHAN tanpa sengaja (mis. tes insert yang lupa
// dibersihkan, atau tes yang mengubah data produksi).
//
// Karena itu binding di bawah DIPAKSA: `DIRECT_URL` dikosongkan, jadi tes apa
// pun yang mencoba membuka koneksi berhenti di gerbang
// "Secret DIRECT_URL belum di-set" (HTTP 500) — bukan query ke DB asli.
//
// `WRITE_TOKEN` sengaja diisi nilai palsu supaya tes tetap bisa melewati
// gerbang token dan menguji lapisan validasi DI BALIKNYA (allowlist tabel,
// validasi game_id, dsb).
// ---------------------------------------------------------------------------

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					DIRECT_URL: "",
					WRITE_TOKEN: "token-uji",
				},
			},
		}),
	],
});
