# Claim asset + polling

## Setup manual

1. Jalankan `supabase/CLAIM_ASSET_PATCH.sql` di Supabase SQL Editor. Patch mengasumsikan `game_asset_jobs` sudah ada dari migration sebelumnya; counter lama per hari didukung dan dikonversi konservatif ke dua slot.
2. Buat antrean Cloudflare sebelum deploy:

```powershell
Set-Location G:\STEAM_PROJECT\our-workers
corepack pnpm install --frozen-lockfile
corepack pnpm exec wrangler queues create game-asset-fetch
corepack pnpm exec wrangler queues create game-asset-fetch-dlq
corepack pnpm exec wrangler secret put RYUU_AUTH_CODE
corepack pnpm exec wrangler secret put HUBCAP_API_KEYS
corepack pnpm exec wrangler secret put ASSET_MASTER_KEY_HEX
```

`HUBCAP_API_KEYS` adalah satu JSON array berisi `{ "id": "key_01", "key": "..." }`, sampai 15 key atau sesuai key yang tersedia. ID harus unik dan stabil; tidak mengandung secret. Master key sama dengan master key SGA1 asset lama. Nilai key tidak ditulis ke repo. R2 credentials yang sudah ada harus memiliki izin baca DAN tulis bucket.

```powershell
corepack pnpm run typecheck
corepack pnpm test --run
# Setelah SQL, antrean, dan secret siap:
corepack pnpm run deploy

Set-Location G:\STEAM_PROJECT\my-apps-testing
corepack pnpm install --frozen-lockfile
corepack pnpm run app:dev
```

FE tetap menggunakan alamat Worker yang sudah dikonfigurasi; tidak mengakses provider langsung. Deploy dan SQL tidak dijalankan otomatis oleh perubahan source ini.

## Kontrak

- POST `/api/claim-game` body `{ "game_id": 620 }`: sesi dan perangkat wajib. Role 2/3 mengunduh tanpa kupon/library baru. Role 4 yang belum memiliki game memerlukan kupon; asset disiapkan sebelum kupon dikurangi. Role lainnya ditolak.
- Katalog membaca semua `game_lists`; jumlah total dan query halaman tidak difilter oleh asset.
- Jika file tersedia: HTTP 200 `application/octet-stream`, header `x-game-id`, `x-game-name` URL-encoded, dan `x-game-size`.
- Jika belum tersedia: HTTP 202 `{ "ok": true, "status": "processing", "game_id": 620, "retry_after_seconds": 3 }`. Consumer Queue menyiapkan asset secara independen dari koneksi FE.
- GET `/api/claim/status/620`: sesi wajib, status `processing`, `ready`, `not_found`, `failed`, `retry`, atau `idle`. Polling tidak memakai jatah download. `retry` berarti lease kedaluwarsa; kirim POST claim lagi untuk mengantrekan ulang.
- FE polling dengan jeda 2-10 detik, berhenti saat layar ditutup, paling lama 10 menit. Saat ready, POST claim lagi untuk file. JSON 202 tidak pernah dikirim ke penyimpanan file.
- Limit semua role yang diizinkan: 50 respons file per sesi 00:00-12:00 dan 12:00-24:00 WIB. DB menentukan tanggal/slot. Termasuk unduh ulang. HTTP 429 `DOWNLOAD_LIMIT` ketika penuh. Kupon dan counter diubah dalam transaksi yang sama. File dipastikan tersedia sebelum transaksi. Setelah respons disiapkan/commit, putusnya client atau kegagalan simpan lokal tidak mengembalikan counter; unduh ulang tidak memakai kupon kedua.
- Asset job lease 5 menit. Worker lama tidak bisa mempublikasikan hasil setelah token berpindah. Upload memakai key immutable `lua/<appid>/<lease-token>.lua`; `r2_object_key` menunjuk hasil yang sah. File lama `lua/<appid>.lua` tetap dibaca jika belum ada pointer versi.
- Asset DB SGA1 yang valid dapat dipulihkan ke R2 tanpa provider. Provider 2 dicoba dahulu; hanya 404 lanjut provider 3. Respons HTML/JSON kosong atau file tanpa `addappid(...)` ditolak. Ini pemeriksaan struktur file, bukan eksekusi Lua atau pembuktian semua depot milik AppID tertentu.
- Hasil baru disimpan terenkripsi SGA1/AES-256-GCM di `game_assets.lua_data`, versi 1. `meta_data` lama dipertahankan. Tidak dibuat metadata palsu ketika provider hanya mengirim Lua.
- Dua provider 404: `ASSET_NOT_FOUND`, cooldown 1 jam. Error lain: `failed`, cooldown 60 detik. File legacy R2 yang baru tersedia tetap dapat diunduh selama cooldown. FE menampilkan pesan server untuk kuota/provider tidak tersedia.
- Provider 3: reservasi per key atomik sebelum GET Lua; failed/unknown request dihitung konservatif. Stats diperiksa mulai counter 22 atau mendekati limit, maksimal sekali per menit per key. Sync memakai nilai `daily_usage`/`daily_limit` aktual plus request berjalan. Reset mengikuti stats provider, bukan pergantian sesi WIB. Health/status provider tidak digunakan.
- HTTP 429 provider: pindah key setelah menandai penuh sementara. 401 provider: nonaktifkan key; ganti secret dan aktifkan kembali `provider_key_usage.enabled` secara manual. 403 diblok sementara dan diperiksa lewat stats, karena bisa berarti kuota/izin/masa berlaku. HTTP 404 tidak dicoba ulang dengan key lain. Provider 5xx/timeout berbeda dari game tidak ditemukan.
- Stats key disimpan berdasarkan ID, tidak pernah secret. Reservation yang ditinggalkan consumer mati dibersihkan setelah kedaluwarsa; counter tetap konservatif sampai stats berikutnya. Jika stats sedang disinkronkan oleh job lain, key bisa sementara dilewati.

## Invoice / library

Claim invoice mengunci user sebelum invoice, sama dengan urutan free claim. FK aktual `history_purchase.game_id` diperiksa untuk menentukan apakah referensinya `game_lists.id` atau `app_id`; tidak mengubah FK/data lama. Invoice yang sudah memiliki `user_id` hanya bisa diklaim pemiliknya; invoice tanpa pemilik bisa diklaim pertama kali lalu ditautkan ke user. Role 4 menautkan `purchase_id` ke library; kepemilikan yang sudah ada tidak diduplikasi. Role 2/3 tidak membuat baris library AppID 0 karena FK terbaru melarangnya.

Riwayat Account hanya menampilkan invoice yang ditautkan melalui `history_purchase.user_id` atau `user_list_game.purchase_id`, bukan kecocokan AppID saja. Invoice lama tanpa kedua tautan tidak ditebak pemiliknya dan tidak ditampilkan sampai dipetakan manual. Tidak ada migrasi massal pemilik invoice.

## Batas verifikasi

Tes Worker memakai DIRECT_URL kosong dan provider mock. Typecheck, enkripsi SGA1, dan bundle FE diperiksa lokal. SQL/counter juga dapat diperiksa di PostgreSQL WASM lokal; hasil tersebut tidak membuktikan multi-instance runtime Cloudflare atau koneksi Supabase/R2/provider produksi. Setelah setup manual, lakukan uji dua user untuk AppID yang belum ada, kupon role 4, batas download, dan rollover sesi.

Upload berhasil tetapi commit DB gagal dapat meninggalkan objek R2 tanpa referensi. Key immutable menjaga hasil aktif; objek tanpa referensi perlu dibersihkan terpisah dengan memeriksa pointer job, tanpa menghapus objek aktif.

Referensi konfigurasi Queue: https://developers.cloudflare.com/queues/configuration/configure-queues/
