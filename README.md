# worker-toko

> Implementasi claim terbaru (fallback provider 2/3, Queue, polling FE, enkripsi SGA1, dan limit 50 unduhan per sesi 12 jam) serta langkah setup manual ada di [CLAIM_SETUP.md](./CLAIM_SETUP.md). Patch lanjutan Supabase: [CLAIM_ASSET_PATCH.sql](./supabase/CLAIM_ASSET_PATCH.sql). Bagian dokumentasi katalog/struktur lama di bawah belum seluruhnya mengikuti schema terbaru.

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
eksplisit di `src/lib/db.ts`, supaya tidak ada yang menyangka koneksi ini aman.
Panduan resmi Cloudflare sendiri menyarankan Hyperdrive untuk Postgres.

**Kalau nanti ingin terenkripsi:** pindah ke Hyperdrive. Yang perlu diganti
hanya cara `createDb()` memperoleh connection string.

## Struktur file

```
src/
├── index.ts               ENTRY: tabel ROUTES + gerbang token + penanganan
│                          error global. Tidak ada SQL di sini.
├── config.ts              nama worker, nama tabel, allowlist, batas limit
├── shape.ts               bentuk JSON gabungan game + asset (shapeGame)
├── lib/
│   ├── db.ts              createDb() + seluruh catatan soal enkripsi
│   ├── http.ts            json/fail, scrub(), perbandingan token
│   ├── params.ts          readInt/readList/readBool/escapeLike pembaca query
│   └── types.ts           kontrak rute: prepare() & handle()
└── routes/
    ├── health.ts          GET  /api/health
    ├── inspect.ts         GET  /api/db/inspect
    ├── games-list.ts      GET  /api/games
    └── games-detail.ts    GET  /api/games/:game_id
test/
├── routes.spec.ts         lapisan HTTP: rute, token, urutan validasi
└── units.spec.ts          fungsi murni: shapeGame, readInt/readList, scrub
```

Satu rute = satu file, jadi hampir semua pekerjaan satu endpoint ada di file
rutenya sendiri.

| Mau ubah… | Buka |
|---|---|
| Aturan token / daftar rute | `src/index.ts` |
| Nama tabel, batas `limit` | `src/config.ts` |
| Koneksi DB, `ssl`, jumlah koneksi | `src/lib/db.ts` |
| Format JSON balasan game | `src/shape.ts` |
| Perilaku satu endpoint | `src/routes/<endpoint>.ts` |

## Cara menambah rute baru

1. Buat `src/routes/<nama>.ts`, ekspor objek `PlainRoute` (tanpa DB) atau
   `DbRoute` (butuh DB) — bentuknya ada di `src/lib/types.ts`.
2. Isi `prepare()` **hanya** untuk validasi masukan (tidak menyentuh DB), dan
   `handle()` untuk pekerjaannya. Semua penolakan yang mungkin terjadi taruh di
   `prepare()`, supaya permintaan ngawur tidak pernah membuka koneksi database.
3. Daftarkan di tabel `ROUTES` di `src/index.ts`. Rute berparameter
   (`/api/games/:game_id`) wajib **setelah** rute statis.
4. Tambah tes di `test/routes.spec.ts`.

Daftar rute di `GET /api/health` dihasilkan otomatis dari `ROUTES`, jadi tidak
ada dua tempat yang perlu disamakan manual.

## Kalau nanti perlu worker lain

Repo ini sekarang sengaja **satu worker**: `wrangler.jsonc`, `package.json`, dan
`.dev.vars` hanya bisa mewakili satu worker. Kalau nanti muncul pekerjaan kedua
(cron, webhook, dsb), jangan ditumpuk di `src/` — pindahkan dulu ke bentuk:

```
workers/game-store/      <- isi repo ini sekarang
workers/<nama-baru>/     <- worker baru, wrangler.jsonc sendiri
packages/worker-kit/     <- kode yang dipakai bersama (db/http/params)
```

Root repo lalu berisi `package.json` (script agregat) + `pnpm-workspace.yaml`.
Selama masih satu worker, struktur sekarang lebih sederhana dan itu memang
yang dipilih.

## Rute

| Rute | Butuh token | Fungsi |
|---|---|---|
| `GET /api/health` | — | Status Worker (tidak menyentuh DB) |
| `GET /api/db/inspect?table=…` | ✅ `x-write-token` | Daftar kolom tabel (diagnosa) |
| `GET /api/games` | — | Daftar game: paginasi + pencarian + filter (ringkas) |
| `GET /api/games/:game_id` | — | Satu game + asset penuh (termasuk `metadata`) |

### Parameter `GET /api/games`

| Parameter | Bawaan | Arti |
|---|---|---|
| `page` | 1 | Halaman ke-N (maks 10000; nilai di luar batas dijepit) |
| `page_size` | 24 | Baris per halaman (maks 100) |
| `search` | — | Satu kata kunci, dicocokkan ke `game_name`/`description`/`genre`/`category`/`tags` |
| `category` | — | Saring kategori (boleh banyak nilai) |
| `genre` | — | Saring genre (boleh banyak nilai) |
| `tags` | — | Saring tags (boleh banyak nilai, kecocokan sebagian) |
| `full` | `0` | `1` = sertakan `lua_data`+`metadata`+`encyription` mentah |

Filter multi-nilai boleh ditulis dua gaya, dan boleh dicampur:

```
?genre=RPG&genre=Action        # diulang
?genre=RPG,Action              # dipisah koma
?genre=RPG&category=Action     # gabungan
```

Aturannya: **"atau" di dalam satu parameter, "dan" antar parameter.**

| Permintaan | Artinya |
|---|---|
| `?genre=RPG,Action` | genre `RPG` **atau** `Action` |
| `?category=RPG&genre=Action` | kategori `RPG` **dan** genre `Action` |

`search` berbeda: satu kata kunci dicocokkan ke beberapa kolom sekaligus
(`game_name` **atau** `description` **atau** `genre` **atau** `category` **atau**
`tags`). Wildcard `%` dan `_` di dalam kata kunci dinetralkan, jadi
`?search=%` mencari tanda persen yang harfiah — bukan mengembalikan semua baris.

Responsnya menyertakan `total`, `total_pages`, dan `has_more`, jadi client bisa
membuat navigasi halaman tanpa query hitung terpisah. `page` dan `page_size`
dijepit ke batasnya (bukan ditolak), jadi `?page_size=99999` tetap 200 dengan
`page_size` 100.

Contoh respons:

```jsonc
{
  "ok": true,
  "count": 2,            // jumlah baris di halaman ini
  "page": 1,
  "page_size": 2,
  "total": 3,            // total baris yang cocok filter
  "total_pages": 2,
  "has_more": true,
  "search": null,
  "filters": { "category": ["RPG"], "genre": [], "tags": [] },
  "data": [ /* … */ ]
}
```

### Urutan satu permintaan

Rute dicocokkan → gerbang token → `prepare()` (validasi, **belum** buka DB) →
koneksi DB dibuka → `handle()` → koneksi ditutup lewat `ctx.waitUntil()`.

Rute tak dikenal, method salah, token salah, `game_id` bukan angka, tabel tak
diizinkan, dan body kosong semuanya ditolak **sebelum** koneksi database dibuat.

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

> Jadi: `pnpm test` untuk logika (tanpa DB), `wrangler dev --remote` bila ingin
> menembak DB sungguhan, dan `wrangler versions upload` kalau mau mencoba versi
> baru di URL preview sebelum `pnpm run deploy`.

## Tes

```bash
pnpm test           # 27 tes di 2 file
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

`test/units.spec.ts` menguji fungsi murni (`shapeGame`, `readInt`, `scrub`);
`test/routes.spec.ts` menguji lapisan HTTP (pencocokan rute, gerbang token,
urutan validasi).

## Gaya penamaan

Seluruh **nama** di kode — fungsi, variabel, konstanta, tipe, dan kunci JSON
respons — memakai **bahasa Inggris** (`shapeGame`, `readInt`, `createDb`,
`ALLOWED_TABLES`, `has_asset`, `encrypted`, `routes`). **Komentar dan pesan
error tetap bahasa Indonesia.**

Pengecualian yang disengaja: kunci yang berasal langsung dari kolom database
tetap apa adanya (`game_name`, `metadata_json`, `has_more`, `encyription`) —
mengubahnya justru bikin bingung saat membandingkan respons dengan isi tabel.

## Jebakan driver Postgres (sudah pernah kena, jangan diulang)

**1. Jangan pakai `= any($1)` untuk daftar nilai.** Di runtime Worker dua-duanya
gagal, walau di Node biasa terlihat benar:

```ts
sql`g.category = any(${categories})`            // malformed array literal: "RPG,Action"
sql`g.category = any(${sql.array(categories)})` // op ANY/ALL (array) requires array on right side
```

Sebabnya: driver menentukan tipe parameter dari peta OID → OID-array yang diisi
saat handshake (`fetchArrayTypes`). Di runtime Worker peta itu kosong, jadi
daftar dikirim sebagai teks biasa, bukan `text[]`.

Yang benar — tidak bergantung pada OID sama sekali, dan koma di dalam nilai
tetap aman karena tiap anggota jadi parameter sendiri:

```ts
sql`g.category in ${sql(categories)}`
```

Untuk kecocokan sebagian (kolom teks berisi daftar dipisah koma), gabung pola
dengan `or`:

```ts
const pola = tags.map((t) => sql`g.tags ilike ${`%${escapeLike(t)}%`}`);
conditions.push(sql`(${pola.reduce((a, b) => sql`${a} or ${b}`)})`);
```

**2. Kolom hasil SELECT harus benar-benar ada di tabel.** Nama kolom di SELECT
tidak diperiksa TypeScript — salah nama baru ketahuan saat runtime
(`column g.previev_url_img does not exist`). Periksa dulu dengan
`GET /api/db/inspect?table=…` sebelum menambah kolom ke SELECT.
Kolom `previev_url_img` dulu ada (salah ketik di DB) dan kini sudah dihapus.

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
