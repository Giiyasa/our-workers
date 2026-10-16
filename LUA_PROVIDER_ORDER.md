# Urutan download Lua

1. R2 existing (claim route).
2. Database game_assets (asset job).
3. Ryuu.
4. LuaTools: https://lua.tools/api/manifest/download?appid=APP_ID&source=Luie
5. Hubcap.

Ryuu hanya meneruskan jika HTTP 404, mengikuti perilaku sebelumnya. LuaTools memakai pool fixes_provider_accounts dan refresh otomatis yang sudah ada; membutuhkan akun admin siap. Reservasi memakai kuota akun yang sama (24/hari WIB) dengan Fixes/Manifest. Semua kegagalan sumber LuaTools meneruskan ke Hubcap tanpa mengekspor token ke frontend. Hubcap tetap dicatat sebagai provider_3 untuk kompatibilitas metadata historis; LuaTools dicatat sebagai luatools_luie.

Respons LuaTools boleh bare Lua atau ZIP Stored/Deflate. ZIP maksimal 32 MiB, paling banyak 5.000 entry, Lua maksimal 1.000.000 byte. Pilih basename APP_ID.lua, atau satu-satunya file Lua jika tidak ada nama yang cocok. Periksa CRC, ukuran dan addappid AppID yang diminta. Manifest dan file lain diabaikan; tidak ada file paket yang dijalankan. Hasil Lua tetap diupload ke R2 dan dienkripsi ke database lewat alur asset job existing.

Tidak perlu ENV, SQL atau build Tauri baru. Deploy Worker terbaru; akun LuaTools dan key Hubcap existing tetap digunakan. Pengujian HEAD tanpa token mendapat HTTP 401; download autentikasi produksi belum diuji.

ZIP menggunakan node:zlib yang didukung runtime Worker: https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/

## Refresh dan rotasi akun Luie

Luie dan Fixes menggunakan helper akun yang sama. Setiap permintaan upstream direservasi atomik, maksimum 24 per akun per hari Asia/Jakarta; percobaan gagal dan retry tetap dihitung. Login dan refresh tidak menghapus usage atau blokir provider. Pemilihan mengutamakan akun ready dengan usage terendah, sesi valid, dan tanpa blokir aktif; akun yang sudah dicoba dalam satu operasi dilewati.

Sesi kedaluwarsa dicoba refresh di bawah row lock. Respons refresh 400/401/403 menjadi REFRESH_REJECTED dan membutuhkan login ulang. Gangguan jaringan, HTTP lain, atau respons token tidak valid diberi cooldown minimal 60 detik, lalu bisa dicoba lagi. Request refresh timeout setelah 8 detik. Token kosong tidak disimpan. Key enkripsi yang hilang ditolak sebelum reservasi; sesi yang tidak bisa didekripsi ditandai dan pemilihan berlanjut ke akun lain.

HTTP 401 download mencoba refresh satu kali per akun, dengan pemeriksaan versi sesi agar respons lama tidak membatalkan sesi baru. HTTP 403, 429, atau refresh gagal melanjutkan ke akun lain. Maksimum empat percobaan download per operasi; percobaan baru tidak dimulai setelah 90 detik (request yang sedang berjalan tetap memiliki timeout sendiri). Setelah pool gagal, alur Lua melanjutkan ke Hubcap. HTTP 404 atau gangguan server download tidak menghabiskan seluruh pool dengan retry per akun.

Log fixes_account_reserved, fixes_account_rotating, fixes_account_auth_recovered, fixes_account_session_invalid, dan fixes_session_refresh_completed/failed menyebut accountId. Log kegagalan refresh menyertakan code dan upstreamStatus jika tersedia, tanpa access token, refresh token, atau URL bertanda tangan. outcome=skipped berarti refresh tidak dijalankan karena sesi sudah berubah atau row sedang dikunci. Perubahan ini perlu deploy Worker; tidak membutuhkan migrasi SQL atau build desktop.
