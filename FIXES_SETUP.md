# Fixes: setup dan operasi admin

Implementasi berada pada Worker `worker-toko` yang sama dengan auth/claim. R2 tetap memakai endpoint/bucket/kredensial yang sudah menyimpan Lua. Tidak ada Worker storage kedua.

## Alur

1. Desktop membaca katalog dan detail dari Worker/DB.
2. Worker memeriksa sesi aplikasi, role, dan kepemilikan sebelum menyiapkan paket.
3. Metadata paket siap diverifikasi melalui HEAD objek R2. Objek ada: download melalui Worker.
4. Objek belum ada: satu job `FIXES_QUEUE` meminta link dari LuaTools dengan sesi provider admin.
5. Worker mengambil URL dari respons LuaTools, memeriksa HTTPS/domain publik dan DNS pada setiap redirect, lalu mengunduh tanpa meneruskan bearer provider ke host file. Host dicatat otomatis di DB. Paket diperiksa dan diunggah multipart ke R2; tidak ada konfigurasi host manual.
6. Setelah upload lengkap, job menyimpan object key, ukuran, dan SHA-256. Desktop polling prepare hingga ready.
7. Desktop mengunduh dari Worker langsung ke file sementara, memverifikasi checksum, lalu memasang secara lokal.

Prefix Lua existing tidak diubah. Paket baru:
`fixes/<sha256-fix-id>/<metadata-revision>/<manifest|fix>/<lease-uuid>.bin`.

Revisi adalah hash snapshot metadata yang tersedia, bukan klaim bahwa upstream menyediakan nomor versi binary. Jika isi upstream berubah tanpa perubahan metadata, admin menggunakan `invalidate`. Objek lama tidak dihapus; permintaan berikutnya mengisi cache baru. Cache yang sudah siap tidak memerlukan sesi provider valid.

## Database

Untuk setup baru, terapkan `supabase/FIXES_PATCH.sql` lalu `supabase/FIXES_MULTIACCOUNT_PATCH.sql`. Jika patch awal sudah diterapkan, jalankan **hanya** patch multiaccount melalui workflow migrasi yang biasa digunakan. Patch ini belum dijalankan ke database produksi. Jangan menjalankan ulang patch claim/base schema.

Tabel tambahan: `fixes_catalog`, `fixes_entries`, `fixes_package_jobs`, `fixes_provider_session`, `fixes_download_usage`. Semuanya private (RLS aktif; hak anon/authenticated/PUBLIC dicabut). Role server pada DIRECT_URL perlu hak tabel yang sesuai; koneksi client tidak diberi akses langsung.

Sesi provider mendukung banyak akun, masing-masing terenkripsi AES-256-GCM dengan secret `FIXES_SESSION_KEY_HEX`. Login diverifikasi melalui provider `/auth/v1/user`; account ID adalah ID asli provider. Login ulang dan refresh akun yang sama tidak mereset kuota atau blok rate limit. Legacy singleton tetap tersimpan di tabel lama untuk recovery/audit, tetapi tidak dipakai oleh pool. Login ulang mendaftarkan identitas provider terverifikasi; tabel lama tidak dihapus.

Setiap akun mendapat maksimal **24 permintaan paket upstream per hari WIB**, reset pukul 00.00 Asia/Jakarta. Manifest dan Fix masing-masing menggunakan satu permintaan. Reservasi dilakukan atomik sebelum meminta link, termasuk saat inspeksi `host`; percobaan gagal/tidak pasti tetap dihitung. Kuota ini adalah batas lokal aplikasi, bukan klaim tentang batas server LuaTools. Pemakaian akun yang sama di luar Worker tidak dapat diamati; jika provider menolak dengan 429, akun diblok lokal hingga hari berikutnya. Tidak ada bypass pembatasan provider.

Worker memilih akun ready, belum kedaluwarsa, tidak diblok, dan masih memiliki kuota. Akun terpilih dikunci selama reservasi; counter DB memiliki batas keras 24. Cache R2 tidak menggunakan kuota provider. Batas download Fixes per-user 50/12 jam yang sempat dibuat tidak lagi dipakai; quota/coupon claim existing tetap utuh. Jika semua akun tidak tersedia, user menerima 503 generic, tanpa popup Discord atau logout aplikasi.

## Queue dan secret

Dari repo `our-workers`:

```powershell
corepack pnpm exec wrangler queues create fixes-package-fetch
corepack pnpm exec wrangler queues create fixes-package-fetch-dlq

# Buat kunci baru tanpa menaruh nilainya di source atau terminal output.
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | corepack pnpm exec wrangler secret put FIXES_SESSION_KEY_HEX
```

Nilai tetap API/auth URL, anon key publik, callback Discord, default Worker URL, kuota 24 dan zona waktu berada di `src/fixes-config.mjs`, dibaca Worker dan CLI. Tidak perlu mengisi `LUATOOLS_ANON_KEY` atau `FIXES_DOWNLOAD_HOSTS` sebagai ENV. Host file ditemukan dari respons endpoint LuaTools yang tetap, diperiksa otomatis, dan dicatat di `fixes_provider_config` untuk audit. Daftar tersebut bukan allowlist yang harus diisi admin; boleh kosong saat awal setup. Kredensial rahasia tetap menggunakan secret existing; hanya kunci enkripsi sesi yang baru.

Kredensial `R2_*`, `DIRECT_URL`, `WRITE_TOKEN`, serta queue Lua existing dipertahankan. Kredensial R2 harus mengizinkan multipart create/upload/complete/abort pada prefix Fixes. Prefix Fixes sebaiknya mempunyai lifecycle untuk multipart tidak lengkap. Objek selesai yang menjadi orphan akibat lease/revisi usang dipertahankan; pembersihannya belum otomatis.

Bundle dapat diperiksa tanpa deploy:

```powershell
corepack pnpm exec wrangler deploy --dry-run --outdir .verification/fixes-worker
```

Setelah migrasi, queue, dan secret siap, deployment mengikuti workflow existing (`corepack pnpm deploy`). Perubahan ini belum dipublikasikan ke Cloudflare.

## CLI admin

CLI memakai WRITE_TOKEN existing dari `.dev.vars` secara read-only, tanpa mencetaknya. Jika tidak tersedia, gunakan `FIXES_ADMIN_WRITE_TOKEN` di shell admin; secret tidak menjadi argumen command atau output. `FIXES_ADMIN_WRITE_TOKEN` adalah WRITE_TOKEN existing, bukan token user desktop. Default Worker URL sama dengan desktop; dapat diatur melalui `FIXES_WORKER_URL` (HTTPS).

```powershell
# Hanya bila WRITE_TOKEN existing tidak ada di .dev.vars:
# $env:FIXES_ADMIN_WRITE_TOKEN = [Net.NetworkCredential]::new('', (Read-Host 'WRITE_TOKEN admin' -AsSecureString)).Password

node scripts/fixes-admin.mjs login akun-utama --open
# Jalankan lagi dan pilih Discord akun berbeda untuk menambah akun:
node scripts/fixes-admin.mjs login akun-kedua --open
node scripts/fixes-admin.mjs status
node scripts/fixes-admin.mjs sync
node scripts/fixes-admin.mjs sync 620

# Selesai: buka menu Fixes di desktop dan pilih Manifest/Fix.
# Tidak perlu mencari Fix ID atau menjalankan host/hosts.

# Refresh hanya dilakukan admin, tidak dipicu permintaan user.
node scripts/fixes-admin.mjs refresh ACCOUNT_ID
node scripts/fixes-admin.mjs disable ACCOUNT_ID
node scripts/fixes-admin.mjs enable ACCOUNT_ID
```

Login awal memakai PKCE Supabase/Discord dengan callback `http://localhost:53789/callback`, sama dengan LuaTools. Port tersebut harus bebas. Browser hanya dibuka jika admin memilih `--open`. Refresh yang dicabut/gagal membutuhkan login admin ulang. Respons token lama tidak dapat menandai sesi baru hasil refresh sebagai gagal.

Import sesi alternatif: `node scripts/fixes-admin.mjs session`, kemudian masukkan JSON melalui stdin (`access_token`, `refresh_token`, `expires_at` ISO). Jangan menaruh JSON/token di Git, command history, atau file yang dibagikan.

Tidak ada panel admin web baru; operasi admin tersedia lewat CLI dan API private di bawah.

## API

| Method | Path | Akses / fungsi |
|---|---|---|
| GET | `/api/fixes?q=&tag=&page=&installed=` | Sesi aplikasi; katalog DB, 24 game/halaman |
| GET | `/api/fixes/:app_id` | Sesi aplikasi; detail DB, cache detail 1 jam |
| POST | `/api/fixes/prepare` | Sesi aplikasi; `{fix_id,revision,slot}`; ready atau 202 processing |
| GET | `/api/fixes/package?fix_id=&revision=&slot=` | Sesi aplikasi; streaming objek R2 |
| POST | `/api/admin/fixes/session` | WRITE_TOKEN; simpan sesi terenkripsi |
| POST | `/api/admin/fixes/refresh` | WRITE_TOKEN; `{account_id}` refresh satu akun |
| POST | `/api/admin/fixes/account` | WRITE_TOKEN; `{account_id,enabled}` aktif/nonaktif |
| POST | `/api/admin/fixes/config` | WRITE_TOKEN; `{download_hosts:[...]}` seed/reset daftar audit, opsional; bukan gate download |
| GET | `/api/admin/fixes/status` | WRITE_TOKEN; semua akun, pemakaian/sisa kuota hari ini dan error job, tanpa token |
| POST | `/api/admin/fixes/sync` | WRITE_TOKEN; `{}` untuk katalog atau `{app_id}` untuk detail |
| POST | `/api/admin/fixes/host` | WRITE_TOKEN; diagnostik opsional hostname paket saja, memakai kuota upstream |
| POST | `/api/admin/fixes/invalidate` | WRITE_TOKEN; invalidasi cache slot current revision |

Role 2/3 melihat dan dapat mengambil seluruh katalog. Role 4 hanya melihat daftar game, kategori dan detail untuk AppID miliknya dalam `user_list_game`, melalui claim existing. Filter ini server-side, termasuk pencarian/paginasi; bukan filter instalasi Steam lokal. Library kosong menghasilkan katalog kosong. Fixes tidak menambahkan kepemilikan atau memotong free-claim coupon. Kuota 24/hari diterapkan pada akun provider, bukan pada user yang mengambil paket R2.

User tidak melihat token provider atau error auth provider. Error provider menjadi HTTP 503 generic, bukan 401 yang akan memicu logout aplikasi. Status rinci hanya pada API admin.

Katalog awal disinkronkan oleh admin. Detail diisi ketika dibuka dan diperbarui setelah 1 jam; cache lama tetap dipakai bila refresh detail upstream gagal. Tidak ada cron sync/refresh provider otomatis.

## Verifikasi

```powershell
corepack pnpm typecheck
corepack pnpm test --run
corepack pnpm test:fixes-db
corepack pnpm test:fixes-admin
```

Test Worker memakai binding uji dan tidak membuka DB produksi. Test DB menggunakan PostgreSQL sementara PGlite dan membaca SQL job dari implementasi. Test R2/provider memakai fixture HTTP, bukan paket nyata.

Multipart memakai chunk 8 MiB, di atas minimum part non-final 5 MiB menurut [dokumentasi R2](https://developers.cloudflare.com/r2/objects/upload-objects/). POST multipart memakai header SigV4; GET/HEAD tetap memakai presigned URL sesuai [operasi R2](https://developers.cloudflare.com/r2/api/s3/presigned-urls/). Batas paket dan hasil ekstraksi saat ini 4 GiB. Kapasitas/CPU/subrequest pada plan Worker produksi tetap perlu diverifikasi dengan paket nyata.

## Host download otomatis

Setup admin normal cukup login dan sync katalog setelah Worker/queue/secret/database siap. ID paket berasal dari katalog dan dikirim frontend otomatis ketika Manifest/Fix ditekan. Endpoint prepare/queue tidak menerima URL download dari user; URL hanya berasal dari endpoint download LuaTools yang tetap dan terautentikasi.

Worker menolak HTTP, kredensial di URL, port alternatif, IP literal, nama lokal, dan hasil DNS private/reserved. Redirect diperiksa ulang sebelum request berikutnya; bearer LuaTools tidak dikirim ke CDN maupun DNS. Resolusi A/AAAA memakai endpoint tetap Cloudflare DNS-over-HTTPS sesuai [dokumentasi DNS JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/). DNS gagal menyebabkan job gagal sementara. Pemeriksaan DNS dan fetch hostname tetap dua operasi terpisah; ini bukan pinning IP transport. Hanya respons provider tepercaya yang boleh memulai download.

Perintah `host`, `hosts`, dan `invalidate` tetap ada untuk diagnostik/operasi lanjutan, bukan prasyarat download. Tidak ada patch SQL tambahan untuk perubahan host otomatis; tabel config yang sudah ada dipakai sebagai audit maksimal 100 hostname.

Sync katalog memakai batch bulk maksimal 16 KiB UTF-8 dalam satu transaksi, sehingga tidak mengirim seluruh snapshot dalam satu parameter maupun satu query per game. Jika menggunakan versi sebelum perbaikan bulk dan mengalami timeout, deploy Worker terbaru lalu ulangi perintah sync. Tidak diperlukan migrasi atau perubahan ENV untuk perbaikan ini.
