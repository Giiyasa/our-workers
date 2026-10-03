/**
 * Variabel lingkungan khusus auth.
 *
 * `worker-configuration.d.ts` dibuat otomatis oleh `wrangler types` dari
 * wrangler.jsonc, jadi file itu TIDAK boleh disunting tangan — isinya hilang
 * begitu `wrangler types` dijalankan lagi. Karena itu tambahan binding auth
 * ditulis di sini: TypeScript tetap menggabungkan deklarasi `interface Env`
 * dari beberapa file, jadi menambah di sini sama sahnya.
 *
 * Semuanya OPSIONAL dengan sengaja:
 *   - `AUTH_SECRET` kosong  -> dipakai nilai pengembangan, dan /api/health
 *     melaporkan `authSecretTemporary: true`
 *   - `RESEND_API_KEY` dan `MAIL_FROM` kosong -> pengiriman email jatuh ke
 *     MODE UJI (kode OTP ikut dikembalikan di respons, lihat lib/mail.ts)
 *   - `MAIL_WEBHOOK_URL`    -> jalur pengiriman cadangan ke backend sendiri
 *
 * Jangan menaruh NILAI rahasia di file ini. Nilainya dipasang lewat
 * `wrangler secret put <NAMA>` (produksi) atau `.dev.vars` (lokal).
 */
interface Env {
	/** Rahasia penanda tangan token akses. WAJIB di produksi. */
	AUTH_SECRET?: string;
	/** API key Resend untuk mengirim email OTP. */
	RESEND_API_KEY?: string;
	/** Alamat pengirim email OTP, mis. "Toko <no-reply@domain.tld>". */
	MAIL_FROM?: string;
	/** URL webhook pengiriman email milik sendiri (cadangan Resend). */
	MAIL_WEBHOOK_URL?: string;
}
