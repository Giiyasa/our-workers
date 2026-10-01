# worker-toko

API toko game. Worker Cloudflare yang menyambung **langsung** ke Postgres
Supabase memakai string koneksi yang disimpan sebagai secret — **tanpa
Hyperdrive**. Aplikasi desktop tidak pernah memegang kredensial database.

## Kenapa lewat Worker

Connection string database (`postgresql://postgres:...`) adalah kunci induk.
Kalau ditaruh di aplikasi Tauri yang dibagikan ke user, password bisa dibaca
siapa pun yang punya file `.exe`-nya. Worker memindahkan kunci itu ke server:
aplikasi hanya tahu alamat Worker, bukan password database.

## ⚠️ Peringatan: jalur ini TIDAK terenkripsi

Cloudflare Workers **tidak bisa** membuat TLS ke server Postgres. Sudah diuji
berulang di runtime produksi (bukan cuma dev lokal) — semuanya gagal:

| Cara | Hasil |
|---|---|
| `postgres.js` dengan `ssl: true` | `The options.rejectUnauthorized option is not implemented` |
| `pg` (node-postgres) | error yang sama |
| `connect(..., {secureTransport:"on"})` | `proxy request failed` |
| `sock.startTls({expectedServerHostname})` | `TLS Handshake Failed.` |
| `node:tls` di atas socket Workers | `options.rejectUnauthorized ...` |

Pembandingnya: TLS ke server lain **berhasil** (`smtp.gmail.com:465`, 15 ms).
Jadi ini batasan khusus jalur TLS-ke-Postgres, bukan Worker yang tidak bisa
TLS sama sekali.

Akibatnya data — termasuk `password_hash` dan `otp_code` — berjalan **tanpa
enkripsi** antara Cloudflare dan Supabase. Karena itu `ssl: false` ditulis
eksplisit di `src/index.ts`, supaya tidak ada yang menyangka koneksi ini aman.
Panduan resmi Cloudflare sendiri menyarankan Hyperdrive untuk Postgres.

**Kalau nanti ingin terenkripsi:** pindah ke Hyperdrive. Yang perlu diganti
hanya cara `db()` memperoleh connection string.

## Rute

| Rute | Butuh token | Fungsi |
|---|---|---|
| `GET /api/health` | — | Status Worker (tidak menyentuh DB) |
| `GET /api/db/inspect?table=…` | ✅ `x-write-token` | Daftar kolom tabel (diagnosa) |
| `GET /api/games` | — | `game_list` **LEFT JOIN** `game_asset` (ringkas) |
| `GET /api/games/:game_id` | — | Satu game + asset penuh (termasuk `metadata`) |
| `POST /api/games` | ✅ `x-write-token` | Tambah baris ke `game_list` |

### Parameter `GET /api/games`

| Parameter | Bawaan | Arti |
|---|---|---|
| `limit` | 50 | Jumlah baris per halaman (maks 200) |
| `offset` | 0 | Lompati N baris (paginasi) |
| `q` | — | Cari di `game_name`/`genre`/`category`/`tags` |
| `category` | — | Saring kategori persis |
| `full` | `0` | `1` = sertakan `lua_data`+`metadata`+`encyription` mentah |

Responsnya menyertakan `has_more`, jadi client tahu masih ada halaman berikutnya
tanpa perlu query hitung terpisah.

## Bentuk data gabungan

`game_asset.game_id` adalah **PRIMARY KEY** sekaligus **FOREIGN KEY** ke
`game_list(game_id)` (`ON DELETE CASCADE`). Artinya relasinya **1 : 1** — satu
game paling banyak punya satu asset. Karena itu `LEFT JOIN` tidak akan pernah
menggandakan baris `game_list`.

Hasil join yang datar dirapikan jadi bersarang (`shapeGame()`):

```jsonc
{
  "game_id": 620,
  "game_name": "Portal 2",
  "genre": "Puzzle",
  "asset": {
    "has_asset": true,           // false kalau game belum punya asset
    "metadata_bytes": 6998,      // mode ringkas: ukuran, bukan isi
    "metadata_json": { "appid": 10, "name": "Counter-Strike", ... },
    "lua_data": "{}"
  }
}
```

Dua mode sengaja dibedakan: `metadata` ±7 KB per baris, jadi daftar biasa
**tidak** mengirim isinya (cuma ukuran) supaya respons tidak membengkak.

> Catatan: di data contoh sekarang, `metadata` ketiga game isinya **identik**
> (semuanya JSON Counter-Strike, `"appid": 10`) padahal game-nya Portal 2,
> Witcher 3, dan Cyberpunk 2077. Isinya masih contoh hasil salin-tempel, belum
> asset asli per game.

## Yang perlu disiapkan sekali

### 1. Set connection string (rahasia, ke sisi server)

```bash
pnpm exec wrangler secret put DIRECT_URL
# tempel: postgresql://postgres:PASSWORD@db.<project-ref>.supabase.co:5432/postgres
```

Nilainya diminta lewat prompt interaktif, jadi tidak tertinggal di riwayat
shell dan tidak pernah masuk git.

### 2. Set token tulis (rahasia, ke sisi server)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # bikin token acak
pnpm exec wrangler secret put WRITE_TOKEN
```

### 3. Deploy

```bash
pnpm run deploy
```

Cek hasilnya: `https://worker-toko.<akun>.workers.dev/api/health`

## Menjalankan di lokal

`wrangler dev` mode lokal (Miniflare) **tidak bisa** menyambung ke database di
internet — Worker jalan dan `/api/health` membalas, tapi rute yang menyentuh DB
gagal. Untuk menguji DB dari mesin sendiri:

```bash
pnpm run dev:remote
```

Rahasia lokal ditaruh di `.dev.vars` (sudah di-ignore git) — isinya
`DIRECT_URL` dan `WRITE_TOKEN`. Lihat `.dev.vars.example`.

## Tes

```bash
pnpm test           # 22 tes
pnpm run typecheck  # tsc --noEmit
pnpm run cf-typegen # regenerate tipe Env setelah ubah wrangler.jsonc
```

Tes **tidak menyentuh database**. Ini bukan kebetulan — `vitest-pool-workers`
**memuat `.dev.vars` secara default**, jadi tanpa paksaan, tes bisa menembak
database sungguhan. Karena itu `vitest.config.mts` memaksa bindingnya:

```ts
miniflare: { bindings: { DIRECT_URL: "", WRITE_TOKEN: "token-uji" } }
```

`DIRECT_URL` dikosongkan → tes yang mencoba menembak DB berhenti di gerbang
"Secret DIRECT_URL belum di-set" (HTTP 500). `WRITE_TOKEN` diisi palsu supaya
tes tetap bisa melewati gerbang token dan menguji validasi di baliknya
(allowlist tabel, validasi `game_id`, pembaca angka `readInt()`).

## Gaya penamaan

Seluruh **nama** di kode — fungsi, variabel, konstanta, tipe, dan kunci JSON
respons — memakai **bahasa Inggris** (`shapeGame`, `readInt`, `createDb`,
`ALLOWED_TABLES`, `has_asset`, `encrypted`, `routes`). **Komentar dan pesan
error tetap bahasa Indonesia.**

Pengecualian yang disengaja: kunci yang berasal langsung dari kolom database
tetap apa adanya (`game_name`, `metadata_json`, `has_more`, `previev_url_img`,
`encyription`) — mengubahnya justru bikin bingung saat membandingkan respons
dengan isi tabel.

## Catatan keamanan

- **`postgres` adalah kunci induk.** Role ini melewati seluruh RLS. Kalau
  bocor, semua tabel terbuka. Untuk produksi serius, bikin role khusus yang
  hanya boleh menyentuh `game_list`.
- **Semua pesan error disensor** lewat `scrub()` sebelum dikirim ke pemanggil,
  karena driver database gemar menempelkan connection string ke pesan error.
  Sudah diuji: password tidak muncul di respons walau autentikasi gagal.
- **Token wajar ditolak dengan aman**: kalau `WRITE_TOKEN` belum di-set di
  server, semua tulisan ditolak (503), bukan dibuka lebar.
- **Rute tak dikenal & permintaan tanpa token tidak menyentuh DB sama sekali** —
  keduanya ditolak sebelum koneksi dibuat.
- **Jangan nyalakan IPv4 add-on Supabase.** Add-on itu tidak dual-stack: dia
  menukar AAAA jadi A, sehingga host `db.<ref>.supabase.co` berhenti bekerja.
