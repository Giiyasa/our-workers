# Laporan implementasi Fixes

Implementasi source lokal dan build selesai pada 8 Oktober 2026. Belum diaktifkan pada produksi.

## Perubahan

Worker existing memperoleh API Fixes, katalog/detail DB, queue terpisah pada consumer Worker yang sama, cache paket R2, multipart upload, checksum, dan sesi provider terenkripsi. Login/coupon/claim Lua existing dipertahankan. Akun provider diidentifikasi melalui endpoint auth/user, sesi terenkripsi terpisah per akun, kuota atomik 24/hari WIB tidak ter-reset oleh relogin/refresh. Unduhan cache R2 tidak memakai kuota provider atau counter per-user Fixes. Paket siap di R2 tidak memerlukan sesi LuaTools valid; cache miss memakai sesi admin dan mengisi R2 sebelum download user.

Desktop memperoleh menu Fixes, search/filter/My games, detail Markdown, prepare/poll, progress/cancel, deteksi semua library Steam, installer Manifest/Fix, backup, jurnal, dan revert dengan pemeriksaan konflik. Payload tidak dijalankan selama pengujian.

Operasi admin tersedia lewat `scripts/fixes-admin.mjs`: login PKCE, refresh, status, sync, host, session import, dan invalidate. Refresh provider tidak dipicu login/download user.

## Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| Worker TypeScript | Lulus |
| Worker tests | 261 lulus |
| PostgreSQL sementara | Patch rerun/RLS/dedup/lease/stale owner/publication, kuota 24 untuk dua akun, relogin preservation, rollover dan eligibility lulus |
| Admin CLI fixture | Routing multiaccount refresh/disable/hosts/invalidation dan kerahasiaan input rusak lulus |
| Worker deploy dry-run | Lulus; tidak deploy |
| Frontend production build | Lulus |
| Rust tests | 68 lulus, 2 existing tests mesin nyata diabaikan |
| Browser fixture | Catalog/filter/search/detail/Markdown/install-poll/revert lulus |
| Windows Release | Lulus; executable tidak dijalankan untuk game nyata |

Artefak desktop: `../my-apps-testing/src-tauri/target/release/nextgame-desktop.exe`; ukuran dan SHA-256 dicatat di `../my-apps-testing/verification/fixes-build.json`. Screenshot fixture tersedia di folder verification desktop.

## Yang diperlukan untuk aktivasi

1. Setup baru: `supabase/FIXES_PATCH.sql` lalu `supabase/FIXES_MULTIACCOUNT_PATCH.sql`; jika awal sudah diterapkan, hanya patch multiaccount.
2. Buat queue `fixes-package-fetch` dan DLQ-nya.
3. Pasang secret `FIXES_SESSION_KEY_HEX`; nilai tetap ada di `src/fixes-config.mjs` dan host file diperiksa/dicatat otomatis; pertahankan R2/DB/auth secret existing.
4. Deploy Worker melalui workflow existing.
5. Admin melakukan login provider dan sync katalog; user langsung memilih Manifest/Fix. ID paket dan URL/redirect ditangani otomatis, tanpa perintah host manual.
6. Uji end-to-end dengan akun dan paket nyata sebelum distribusi desktop.

Tidak ada migrasi produksi, deploy Cloudflare, login provider nyata, download paket nyata, atau perubahan folder Steam/game user pada pengerjaan ini. Test DB memakai PostgreSQL sementara, HTTP memakai fixture, dan UI memakai mock khusus harness yang tidak masuk build produksi.

Batas yang tercatat: banyak akun provider, masing-masing 24 permintaan upstream/hari WIB; metadata hash bukan versi binary otoritatif; perubahan binary tanpa metadata membutuhkan invalidasi admin; paket/ekstraksi dibatasi 4 GiB; Stored/Deflate ZIP didukung; pause/resume byte-range belum dipindahkan dari queue umum LuaTools; cleanup otomatis objek orphan/backup belum tersedia. Runtime S3 multipart dan kapasitas plan Worker produksi belum terbukti. Detail dan command setup ada di `FIXES_SETUP.md`; detail native/UI ada di `../my-apps-testing/FIXES_IMPLEMENTATION.md`.

Host otomatis: HTTPS/domain/DNS publik dan redirect diperiksa; tidak bergantung daftar host awal. Regresi mencakup first-download tanpa config, redirect CDN publik, penolakan IP/domain private, DNS failure, bearer isolation dan satu reservasi kuota untuk seluruh redirect. Database test mengeksekusi SQL audit host aktual. Tidak ada perubahan frontend/native atau migrasi tambahan untuk revisi ini.

9 Oktober 2026: binding array AppID pada katalog diperbaiki menjadi teks array PostgreSQL eksplisit yang tervalidasi, kompatibel dengan fetch_types:false. Filter kosong My games menghasilkan daftar kosong. Regresi HTTP dan SQL nyata sementara mencakup katalog tanpa filter, filter kosong dan AppID terisi; belum diverifikasi pada Worker produksi.

9 Oktober 2026: sync katalog menggunakan bulk JSON recordset, bukan query per game. Satu advisory lock transaksi dan satu SQL snapshot mengganti loop query; update/insert/deaktivasi tetap atomik. Tes 500 game membuktikan jumlah operasi DB konstan; SQL sementara memverifikasi upsert, deaktivasi dan rerun. Durasi produksi belum diukur.

9 Oktober 2026: sync admin mengembalikan diagnostik aman upstream HTTP status atau SQLSTATE tanpa pesan DB/token. CLI menampilkan diagnostik tersebut. GET anonim katalog dari komputer pengembangan mendapat 403; respons dari Worker produksi belum diverifikasi, jadi sebab 503 produksi belum dipastikan.

9 Oktober 2026: diagnostik sync mencatat stage/error_name dan kode transport Postgres (misalnya CONNECTION_CLOSED), selain SQLSTATE. Error saat membaca body provider diklasifikasikan PROVIDER_BODY_ERROR dan kegagalan cleanup tidak menimpa penyebab aslinya. Log produksi SYNC_FAILED yang diterima belum cukup untuk menentukan penyebab; belum ada bukti perbaikan runtime produksi.

9 Oktober 2026: produksi melaporkan CONNECTION_CLOSED pada write_catalog; koneksi berhasil melewati lock tetapi terputus saat bulk write. Payload kini dibatasi 16 KiB UTF-8 per batch, dalam transaksi yang sama. Tes ukuran/batching/rerun/rollback seluruh snapshot lulus. Ukuran payload sebagai penyebab transport belum terkonfirmasi; perlu deploy/uji produksi. Tidak ada perubahan konfigurasi DB/TLS/auth.

9 Oktober 2026: SQLSTATE 22023 pada batch pertama dapat direproduksi ketika serializer JSON postgres.js mengenkode ulang payload string JSON. Batch sekarang menggunakan ::text::jsonb agar tipe parameter adalah text sebelum parse jsonb. Regresi memakai serializer aktual postgres.js dan PostgreSQL sementara: double encoding menghasilkan 22023, text binding menghasilkan recordset valid. Worker produksi belum diuji ulang.

9 Oktober 2026: role 4 hanya dapat melihat katalog/tags/detail milik user_id pada user_list_game. Pencarian dan total paginasi dihitung setelah ownership filter, memakai EXISTS agar library duplikat tidak menggandakan hasil. Detail langsung di luar library ditolak sebelum provider fetch. Role 2/3 tetap mendapat katalog penuh. Regresi Worker dan query PostgreSQL sementara lulus. Deploy Worker dan muat ulang menu Fixes untuk mengambil hasil baru; tidak ada migrasi atau perubahan frontend untuk fitur ini.
