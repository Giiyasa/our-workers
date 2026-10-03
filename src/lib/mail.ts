/**
 * Pengiriman email OTP.
 *
 * PENTING — kenapa tidak SMTP:
 * Cloudflare Workers TIDAK bisa membuka koneksi TCP sendiri ke server SMTP
 * (batasan runtime yang sama seperti TLS-ke-Postgres di lib/db.ts). Yang bisa
 * dipakai hanya `fetch()` ke REST API penyedia email.
 *
 * Karena itu pengirimnya berlapis, dan dipilih otomatis dari secret yang ada:
 *
 *   1. `RESEND_API_KEY` ada          -> kirim lewat Resend (REST)
 *   2. `MAIL_WEBHOOK_URL` ada        -> kirim ke backend/webhook sendiri
 *   3. tidak ada apa-apa             -> MODE UJI: kode OTP hanya ditulis ke log
 *                                       Worker, dan rute mengembalikannya
 *                                       sebagai `kode_otp_dev`
 *
 * Mode uji sengaja dibuat eksplisit (bukan diam-diam menganggap "terkirim"):
 * rute memakai penanda `mode_email: "uji"` dan menyertakan kodenya, supaya
 * frontend bisa menguji alur OTP sekarang juga. Begitu salah satu secret di
 * atas dipasang, `kode_otp_dev` otomatis hilang dari respons.
 *
 * TIDAK ADA email verifikasi palsu di jalur produksi: kalau pengiriman gagal,
 * responsnya tetap 200 dengan `otp_dikirim: false` dan pesan galatnya — bukan
 * pura-pura sukses.
 */

export type MailMode = "resend" | "webhook" | "uji";

export function mailMode(env: Env): MailMode {
	if (typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.trim()) return "resend";
	if (typeof env.MAIL_WEBHOOK_URL === "string" && env.MAIL_WEBHOOK_URL.trim()) return "webhook";
	return "uji";
}

export interface OtpMail {
	to: string;
	code: string;
	berlakuDetik: number;
	/** Umur token akses setelah verifikasi berhasil (detik). */
	tokenTtlS?: number;
}

export interface MailResult {
	ok: boolean;
	mode: MailMode;
	/** Pesan galat yang aman ditampilkan (tidak memuat rahasia). */
	error: string | null;
}

const OTP_SUBJECT = "Kode verifikasi akun";
const APP_NAME = "worker-toko";

function otpText(mail: OtpMail): string {
	const menit = Math.max(1, Math.round(mail.berlakuDetik / 60));
	return [
		`Kode verifikasi ${APP_NAME}: ${mail.code}`,
		"",
		`Kode ini berlaku ${menit} menit dan hanya bisa dipakai sekali.`,
		"Kalau kamu tidak meminta kode ini, abaikan saja email ini — tanpa kode, akunmu tidak berubah.",
	].join("\n");
}

function otpHtml(mail: OtpMail): string {
	const menit = Math.max(1, Math.round(mail.berlakuDetik / 60));
	return [
		`<p>Kode verifikasi <strong>${APP_NAME}</strong>:</p>`,
		`<p style="font-size:28px;letter-spacing:6px;font-family:monospace"><strong>${mail.code}</strong></p>`,
		`<p>Kode ini berlaku ${menit} menit dan hanya bisa dipakai sekali.</p>`,
		"<p>Kalau kamu tidak meminta kode ini, abaikan saja email ini — tanpa kode, akunmu tidak berubah.</p>",
	].join("");
}

/** Kirim kode OTP lewat jalur yang tersedia. Tidak pernah melempar error. */
export async function sendOtpMail(env: Env, mail: OtpMail): Promise<MailResult> {
	const mode = mailMode(env);

	if (mode === "uji") {
		// Mode uji: tidak ada email keluar. Kode dicatat supaya alur bisa diuji.
		console.log(`[otp][mode-uji] kirim ke ${mail.to}: kode ${mail.code} (berlaku ${mail.berlakuDetik}s)`);
		return { ok: true, mode, error: null };
	}

	try {
		if (mode === "resend") {
			const from = (env.MAIL_FROM ?? "").trim();
			if (!from) {
				return { ok: false, mode, error: "MAIL_FROM belum di-set (wajib untuk Resend)." };
			}
			const res = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					authorization: `Bearer ${env.RESEND_API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					from,
					to: [mail.to],
					subject: OTP_SUBJECT,
					text: otpText(mail),
					html: otpHtml(mail),
				}),
			});
			if (!res.ok) {
				const detail = (await res.text().catch(() => "")).slice(0, 300);
				return { ok: false, mode, error: `Resend membalas ${res.status}: ${detail}` };
			}
			return { ok: true, mode, error: null };
		}

		// mode === "webhook": serahkan ke backend sendiri.
		const webhookUrl = (env.MAIL_WEBHOOK_URL ?? "").trim();
		if (!webhookUrl) {
			return { ok: false, mode, error: "MAIL_WEBHOOK_URL kosong." };
		}
		const res = await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jenis: "otp",
				to: mail.to,
				kode: mail.code,
				berlaku_detik: mail.berlakuDetik,
				subjek: OTP_SUBJECT,
				teks: otpText(mail),
			}),
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			return { ok: false, mode, error: `Webhook email membalas ${res.status}: ${detail}` };
		}
		return { ok: true, mode, error: null };
	} catch (err) {
		const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return { ok: false, mode, error: `Pengiriman email gagal: ${message}`.slice(0, 300) };
	}
}
