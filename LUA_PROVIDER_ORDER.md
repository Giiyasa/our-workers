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
