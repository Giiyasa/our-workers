import type { Sql } from "./db";
import { MAX_LUA_BYTES } from "../config";
import { providerAccessToken, FixesFailure } from "./fixes-provider";
import { extractLuaZip } from "./lua-archive";

export class AssetFailure extends Error {
	constructor(public code: string, message: string, public retrySeconds = 60) { super(message); }
}

async function providerRequest(provider: string, operation: string, url: string | URL, options: RequestInit): Promise<Response> {
	const startedAt = Date.now();
	try {
		// Never follow redirects with provider credentials; expose their HTTP status.
		const response = await fetch(url, { ...options, redirect: "manual" });
		console.info("provider_response", { provider, operation, status: response.status });
		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		const detail = message.includes("redirect") ? "redirect_error"
			: /unsupported|not supported|not implemented/.test(message) ? "unsupported_request_option"
			: /resolve|dns/.test(message) ? "dns_error"
			: /certificate|tls|ssl/.test(message) ? "tls_error"
			: /timeout|timed out/.test(message) ? "timeout"
			: /network|connection/.test(message) ? "network_error" : "unclassified";
		// Fixed labels only: messages and URLs can contain bearer tokens/auth_code.
		console.error("provider_request_failed", { provider, operation, detail, elapsedMs: Date.now() - startedAt });
		throw new AssetFailure("PROVIDER_UNAVAILABLE", `${provider === "ryuu" ? "Ryuu" : provider === "luatools" ? "LuaTools" : "Hubcap"} sementara gagal dihubungi.`);
	}
}

/** Bounded read; never save HTML/JSON errors as a Lua file. */
export async function readLua(response: Response): Promise<Uint8Array> {
	if (!response.body) throw new AssetFailure("PROVIDER_BAD_FILE", "Provider tidak mengirim file Lua.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_LUA_BYTES) throw new AssetFailure("PROVIDER_BAD_FILE", "File provider melebihi batas ukuran.");
			chunks.push(value);
		}
	} finally { await reader.cancel().catch(() => {}); }
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	if (!length || /^\s*[<{]/.test(text) || !/\baddappid\s*\(\s*\d+\s*,/.test(text)) {
		throw new AssetFailure("PROVIDER_BAD_FILE", "Provider mengirim isi yang bukan file Lua yang didukung.");
	}
	return bytes;
}

interface ProviderKey { id: string; key: string }
function providerKeys(env: Env): ProviderKey[] {
	try {
		const value: unknown = JSON.parse(env.HUBCAP_API_KEYS ?? "[]");
		if (!Array.isArray(value) || value.length > 50) throw new Error();
		const keys = value as ProviderKey[];
		if (keys.some((key) => !key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key.id) || typeof key.key !== "string" || !key.key.trim())) throw new Error();
		if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error();
		return keys;
	} catch { throw new AssetFailure("PROVIDER_CONFIG", "Konfigurasi key provider 3 tidak valid."); }
}

async function refreshStats(sql: Sql, config: ProviderKey): Promise<void> {
	// Cleanup crashed requests; their usage remains counted until a confirmed provider reset.
	await sql.begin(async (tx) => {
		await tx`select provider_key_id from provider_key_usage where provider_key_id = ${config.id} for update`;
		await tx`delete from provider_download_reservations where provider_key_id = ${config.id} and expires_at <= now()`;
		await tx`update provider_key_usage set in_flight_count = (select count(*)::int from provider_download_reservations where provider_key_id = ${config.id}) where provider_key_id = ${config.id}`;
	});
	const token = crypto.randomUUID();
	const locked = await sql`
		update provider_key_usage set stats_token = ${token}::uuid, stats_lease_until = now() + interval '15 seconds'
		where provider_key_id = ${config.id} and enabled
		and (daily_usage_count >= least(stats_check_threshold, daily_limit) or blocked_until is not null)
		and (stats_checked_at is null or stats_checked_at < now() - interval '60 seconds')
		and (stats_lease_until is null or stats_lease_until < now())
		returning daily_usage_count, last_provider_daily_usage
	`;
	if (!locked[0]) return;
	try {
		const response = await fetch("https://hubcapmanifest.com/api/v1/user/stats", {
			headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(3000), redirect: "error",
		});
		if (!response.ok) throw new Error();
		const stats = await response.json() as Record<string, unknown>;
		const used = Number(stats.daily_usage), limit = Number(stats.daily_limit);
		if (!Number.isInteger(used) || used < 0 || !Number.isInteger(limit) || limit <= 0 || typeof stats.can_make_requests !== "boolean") throw new Error();
		// Stats is authoritative for the provider's own reset window. Keep reservations
		// not yet reflected by the snapshot; never reset provider counters on WIB midnight.
		await sql`
			update provider_key_usage set
				daily_usage_count = ${used} + greatest(in_flight_count, daily_usage_count - ${Number(locked[0].daily_usage_count)}),
				daily_limit = ${limit}, last_provider_daily_usage = ${used},
				blocked_until = case when ${stats.can_make_requests} then null else now() + interval '60 seconds' end,
				stats_checked_at = now(), stats_token = null, stats_lease_until = null, updated_at = now()
			where provider_key_id = ${config.id} and stats_token = ${token}::uuid
		`;
	} catch {
		await sql`update provider_key_usage set stats_token = null, stats_lease_until = null,
			blocked_until = now() + interval '60 seconds', stats_checked_at = now(), updated_at = now()
			where provider_key_id = ${config.id} and stats_token = ${token}::uuid`;
	}
}

async function hubcap(sql: Sql, env: Env, gameId: number): Promise<Uint8Array | null> {
	const configs = providerKeys(env);
	if (!configs.length) throw new AssetFailure("PROVIDER_CONFIG", "Key provider 3 belum dikonfigurasi.");
	for (const config of configs) {
		await sql`insert into provider_key_usage (provider_key_id) values (${config.id}) on conflict do nothing`;
	}
	const order = await sql`select provider_key_id from provider_key_usage
		where enabled and provider_key_id in ${sql(configs.map((key) => key.id))}
		order by daily_usage_count, last_reserved_at nulls first, provider_key_id`;
	for (const row of order) {
		const config = configs.find((key) => key.id === row.provider_key_id)!;
		await refreshStats(sql, config);
		const reservationId = crypto.randomUUID();
		const reserved = await sql.begin(async (tx) => {
			const rows = await tx`update provider_key_usage
			set daily_usage_count = daily_usage_count + 1, in_flight_count = in_flight_count + 1,
				last_reserved_at = now(), updated_at = now()
			where provider_key_id = ${config.id} and enabled and daily_usage_count < daily_limit
				and (blocked_until is null or blocked_until <= now())
				and (stats_lease_until is null or stats_lease_until <= now())
			returning provider_key_id`;
			if (rows.length) await tx`insert into provider_download_reservations (reservation_id, provider_key_id, expires_at)
				values (${reservationId}::uuid, ${config.id}, now() + interval '60 seconds')`;
			return rows;
		});
		if (!reserved.length) continue;
		try {
			const response = await providerRequest("hubcap", "lua", `https://hubcapmanifest.com/api/v1/lua/${gameId}`, {
				headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(8000), redirect: "error",
			});
			if (response.status === 404) { await response.body?.cancel(); return null; }
			if (response.status === 429) {
				await response.body?.cancel();
				await sql`update provider_key_usage set daily_usage_count = greatest(daily_usage_count, daily_limit),
					blocked_until = now() + interval '60 seconds' where provider_key_id = ${config.id}`;
				continue;
			}
			if (response.status === 401) {
				await response.body?.cancel();
				await sql`update provider_key_usage set enabled = false where provider_key_id = ${config.id}`;
				continue;
			}
			if (response.status === 403) {
				await response.body?.cancel();
				// Some providers use 403 for quota/expired keys; reconcile via stats before classifying.
				await sql`update provider_key_usage set blocked_until = now() + interval '60 seconds',
					daily_usage_count = greatest(daily_usage_count, least(stats_check_threshold, daily_limit)) where provider_key_id = ${config.id}`;
				continue;
			}
			if (!response.ok) { await response.body?.cancel(); throw new AssetFailure("PROVIDER_UNAVAILABLE", "Provider 3 sedang tidak dapat dihubungi."); }
			return await readLua(response);
		} finally {
			// Unknown/failed downloads remain counted conservatively until stats confirms reset.
			await sql.begin(async (tx) => {
				await tx`select provider_key_id from provider_key_usage where provider_key_id = ${config.id} for update`;
				const removed = await tx`delete from provider_download_reservations where reservation_id = ${reservationId}::uuid returning reservation_id`;
				if (removed.length) await tx`update provider_key_usage set in_flight_count = greatest(0, in_flight_count - 1) where provider_key_id = ${config.id}`;
			});
		}
	}
	throw new AssetFailure("PROVIDER_QUOTA", "Kuota atau akses provider sementara tidak tersedia. Coba lagi nanti.");
}

export async function readLuaToolsPackage(response: Response, gameId: number): Promise<Uint8Array> {
    const maxArchive=32*1024*1024;
    if(!response.body || Number(response.headers.get("content-length"))>maxArchive) {
        await response.body?.cancel();
        throw new AssetFailure("PROVIDER_BAD_FILE","Paket LuaTools melebihi batas ukuran.");
    }
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try {
        for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;
            if(length>maxArchive)throw new AssetFailure("PROVIDER_BAD_FILE","Paket LuaTools melebihi batas ukuran.");chunks.push(value);}
    } finally {await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let lua: Uint8Array=bytes;
    if(bytes[0]===0x50 && bytes[1]===0x4b) {
        try {lua=extractLuaZip(bytes,gameId,MAX_LUA_BYTES);}
        catch {throw new AssetFailure("PROVIDER_BAD_FILE","Paket LuaTools tidak memiliki file Lua yang valid.");}
    }
    const valid=await readLua(new Response(lua as Uint8Array<ArrayBuffer>));
    if(!new RegExp(`\\baddappid\\s*\\(\\s*${gameId}\\s*,`).test(new TextDecoder().decode(valid)))
        throw new AssetFailure("PROVIDER_BAD_FILE","File LuaTools tidak sesuai AppID.");
    return valid;
}
async function luaTools(sql: Sql, env: Env, gameId: number): Promise<Uint8Array | null> {
    try {
        const credential=await providerAccessToken(sql,env);
        const url=new URL("https://lua.tools/api/manifest/download");
        url.searchParams.set("appid",String(gameId));url.searchParams.set("source","Luie");
        const response=await providerRequest("luatools","lua",url,{headers:{Authorization:`Bearer ${credential.token}`},signal:AbortSignal.timeout(20000)});
        if(!response.ok) {
            await response.body?.cancel();
            if([401,403].includes(response.status))await sql`update fixes_provider_accounts set status='needs_admin',last_error_code='PROVIDER_AUTH',updated_at=now() where account_id=${credential.accountId}::uuid and xmin::text=${credential.version}`;
            if(response.status===429)await sql`update fixes_provider_accounts set blocked_until=((now() at time zone 'Asia/Jakarta')::date+1)::timestamp at time zone 'Asia/Jakarta',last_error_code='PROVIDER_LIMIT',updated_at=now() where account_id=${credential.accountId}::uuid`;
            console.warn("luatools_lua_fallback",{status:response.status});return null;
        }
        return await readLuaToolsPackage(response,gameId);
    } catch(error) {
        console.warn("luatools_lua_fallback",{code:error instanceof FixesFailure || error instanceof AssetFailure?error.code:"PROVIDER_UNAVAILABLE"});
        return null;
    }
}

export async function fetchProviderLua(sql: Sql, env: Env, gameId: number): Promise<{ bytes: Uint8Array; source: string }> {
	if (!env.RYUU_AUTH_CODE?.trim()) throw new AssetFailure("PROVIDER_CONFIG", "Key provider 2 belum dikonfigurasi.");
	const url = new URL("https://generator.ryuu.lol/resellerlua");
	url.searchParams.set("appid", String(gameId));
	url.searchParams.set("auth_code", env.RYUU_AUTH_CODE);
	const response = await providerRequest("ryuu", "lua", url, { signal: AbortSignal.timeout(8000) });
	if (response.status !== 404) {
		if (!response.ok) { await response.body?.cancel(); throw new AssetFailure("PROVIDER_UNAVAILABLE", "Provider 2 sedang tidak dapat dihubungi."); }
		return { bytes: await readLua(response), source: "provider_2" };
	}
	await response.body?.cancel();
	const luatools = await luaTools(sql, env, gameId);
	if (luatools) return { bytes: luatools, source: "luatools_luie" };
	const bytes = await hubcap(sql, env, gameId);
	if (!bytes) throw new AssetFailure("ASSET_NOT_FOUND", "Asset game belum tersedia pada semua provider.", 3600);
	return { bytes, source: "provider_3" };
}
