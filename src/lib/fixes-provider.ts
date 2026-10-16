import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { FIXES_CONFIG } from '../fixes-config.mjs';
import type { Sql } from './db';
import { encryptAsset, decryptAsset } from './asset-crypto';
import { fetchRyuuCatalog, ryuuFixUrl } from './ryuu-fixes';
export type Slot = 'manifest' | 'fix';
export interface FixTag {
    id: string;
    name: string;
    slug: string;
    color?: string | null;
}
export interface FixEntry {
    id: string;
    title: string;
    description?: string | null;
    tags: FixTag[];
    hasManifest: boolean;
    hasFix: boolean;
    manifestFilename?: string | null;
    fixFilename?: string | null;
    createdAt?: string | null;
    provider?: 'luatools' | 'ryuu';
    sourceUrl?: string;
}
export interface FixGame {
    appid: string;
    name: string;
    header_image?: string | null;
    fixCount: number;
    tags: FixTag[];
    provider?: 'luatools' | 'ryuu';
}
export class FixesFailure extends Error {
    constructor(public code: string, public upstreamStatus?: number) {
        super('Paket sementara belum tersedia. Coba lagi nanti.');
    }
}
const API = FIXES_CONFIG.api;
const AUTH = FIXES_CONFIG.auth;
const RYUU = FIXES_CONFIG.ryuu;
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function safeFilename(value: unknown, slot: Slot): string {
    if (typeof value !== 'string' || value.length > 180 || /[\\/\x00-\x1f\x7f:"<>|?*]/.test(value) || !value.trim())
        throw new FixesFailure('INVALID_FILENAME');
    const name = value.trim();
    if (!/\.(zip|rar|lua|manifest)$/i.test(name) || (slot === 'fix' && !/\.(zip|rar)$/i.test(name)) ||
        (slot === 'manifest' && /\.rar$/i.test(name)))
        throw new FixesFailure('INVALID_FILENAME');
    return name;
}
function validateTags(value: unknown): FixTag[] {
    if (!Array.isArray(value) ||
        value.length > 100 ||
        value.some((t) => !t ||
            typeof t.id !== 'string' ||
            typeof t.name !== 'string' ||
            typeof t.slug !== 'string' ||
            t.id.length > 160 ||
            t.name.length > 250 ||
            t.slug.length > 160))
        throw new FixesFailure('CATALOG_FORMAT');
    return value.map((t) => ({ id: t.id, name: t.name, slug: t.slug, color: typeof t.color === 'string' ? t.color : null }));
}
export function validateFix(value: unknown): FixEntry {
    const f = value as FixEntry;
    if (!f ||
        typeof f.id !== 'string' ||
        !f.id ||
        f.id.length > 160 ||
        typeof f.title !== 'string' ||
        !Array.isArray(f.tags) ||
        typeof f.hasManifest !== 'boolean' ||
        typeof f.hasFix !== 'boolean' ||
        (f.description != null && (typeof f.description !== 'string' || f.description.length > 250000)))
        throw new FixesFailure('CATALOG_FORMAT');
    if (f.hasManifest && f.manifestFilename != null)
        safeFilename(f.manifestFilename, 'manifest');
    if (f.hasFix && f.fixFilename != null)
        safeFilename(f.fixFilename, 'fix');
    return {
        id: f.id,
        title: f.title,
        description: f.description ?? null,
        tags: validateTags(f.tags),
        hasManifest: f.hasManifest,
        hasFix: f.hasFix,
        manifestFilename: f.manifestFilename ?? null,
        fixFilename: f.fixFilename ?? null,
        createdAt: f.createdAt ?? null,
    };
}
export async function jsonFetch(url: string, headers?: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
        res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    }
    catch {
        throw new FixesFailure('PROVIDER_NETWORK');
    }
    if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new FixesFailure(res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : res.status === 429 ? 'PROVIDER_LIMIT' : 'PROVIDER_HTTP', res.status);
    }
    const reader = res.body?.getReader();
    if (!reader)
        throw new FixesFailure('PROVIDER_EMPTY');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 8 * 1024 * 1024)
                throw new FixesFailure('CATALOG_TOO_LARGE');
            chunks.push(value);
        }
    }
    catch (error) {
        if (error instanceof FixesFailure) throw error;
        throw new FixesFailure('PROVIDER_BODY_ERROR', res.status);
    }
    finally {
        await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    }
    catch {
        throw new FixesFailure('CATALOG_FORMAT');
    }
}
export async function syncListings(sql: Sql, onStage: (stage: string) => void = () => {}): Promise<number> {
    onStage("fetch_catalog");
    const data = (await jsonFetch(`${API}/api/denuvo/listings`)) as {
        games?: FixGame[];
    };
    onStage("validate_catalog");
    if (!Array.isArray(data?.games) || !data.games.length || data.games.length > 20000)
        throw new FixesFailure('CATALOG_FORMAT');
    const games: FixGame[] = data.games.map((g) => {
        if (!g || typeof g !== 'object' || !/^\d+$/.test(String(g.appid)) ||
            !Number.isSafeInteger(Number(g.appid)) ||
            Number(g.appid) <= 0 ||
            typeof g.name !== 'string' ||
            !Array.isArray(g.tags))
            throw new FixesFailure('CATALOG_FORMAT');
        return { ...g, tags: validateTags(g.tags), provider: 'luatools' as const };
    });
    if (new Set(games.map(g => String(Number(g.appid)))).size !== games.length)
        throw new FixesFailure('CATALOG_FORMAT');
    onStage('fetch_ryuu_catalog');
    const primaryIds = new Set(games.map(g => String(Number(g.appid))));
    // A primary outage is not an empty catalog. Both snapshots must validate before any writes.
    for (const game of await fetchRyuuCatalog()) {
        if (!primaryIds.has(game.appid)) {
            const { fixes: _, ...listing } = game;
            games.push(listing);
        }
    }
    // Bound each Postgres parameter instead of sending the entire snapshot in one socket write.
    const batches: string[] = [];
    let entries: string[] = [], bytes = 2;
    for (const g of games) {
        const entry = JSON.stringify({app_id:Number(g.appid),name:g.name,header_image:g.header_image ?? null,
            tags:g.tags,fix_count:Number(g.fixCount) || 0,provider:g.provider});
        const size = new TextEncoder().encode(entry).byteLength;
        if (size + 2 > 16 * 1024) throw new FixesFailure('CATALOG_ROW_TOO_LARGE');
        if (entries.length && bytes + size + 1 > 16 * 1024) {
            batches.push(`[${entries.join(',')}]`); entries=[]; bytes=2;
        }
        bytes += size + (entries.length ? 1 : 0); entries.push(entry);
    }
    if (entries.length) batches.push(`[${entries.join(',')}]`);
    onStage("begin_catalog_transaction");
    await sql.begin(async tx => {
        onStage("lock_catalog");
        await tx`select pg_advisory_xact_lock(53789,24)`;
        onStage("deactivate_catalog");
        // All writes are in the same transaction; any failed batch rolls back this change too.
        await tx`update fixes_catalog set active=false where active=true`;
        for (let index=0;index<batches.length;index++) {
            // payload is already JSON text. Bind as PostgreSQL text before casting to jsonb
            // to prevent postgres.js JSON serialization from encoding it a second time.
            const payload=batches[index];
            onStage(`write_catalog_batch_${index+1}_of_${batches.length}`);
            await tx`with incoming as (
 select * from jsonb_to_recordset(${payload}::text::jsonb)
 as g(app_id bigint,name text,header_image text,tags jsonb,fix_count integer,provider text)
), saved as (
 insert into fixes_catalog(app_id,name,header_image,tags,fix_count,active,provider)
 select app_id,name,header_image,tags,fix_count,true,coalesce(provider,'luatools') from incoming order by app_id
 on conflict(app_id) do update set name=excluded.name,header_image=excluded.header_image,
 tags=excluded.tags,fix_count=excluded.fix_count,active=true,synced_at=now(),provider=excluded.provider,
 details_synced_at=case when fixes_catalog.provider=excluded.provider then fixes_catalog.details_synced_at else null end
 returning app_id
)
 select count(*)::int as count from saved`;
        }
        // A source switch invalidates old entries even before the next detail request.
        await tx`update fixes_entries e set active=false from fixes_catalog c where e.app_id=c.app_id
 and e.active=true and coalesce(e.snapshot->>'provider','luatools')<>c.provider`;
        onStage("commit_catalog");
    });
    return games.length;
}
export async function syncDetails(sql: Sql, appId: number): Promise<void> {
    const catalog = await sql`select provider from fixes_catalog where app_id=${appId}::bigint and active=true`;
    if (!catalog[0]) throw new FixesFailure('CATALOG_CHANGED');
    const provider = catalog[0].provider ?? 'luatools';
    let fixes: FixEntry[];
    if (provider === 'ryuu') {
        const game = (await fetchRyuuCatalog()).find(game => game.appid === String(appId));
        // A removed game has no active packages; never retain old downloadable entries.
        fixes = game?.fixes ?? [];
    } else {
        const data = (await jsonFetch(`${API}/api/denuvo/fixes?appid=${appId}`)) as {
            appid?: string;
            fixes?: unknown[];
        };
        if (String(data?.appid) !== String(appId) || !Array.isArray(data.fixes) || data.fixes.length > 1000)
            throw new FixesFailure('CATALOG_FORMAT');
        fixes = data.fixes.map(validateFix);
    }
    await sql.begin(async (tx) => {
        const locked = await tx `select app_id,provider,active from fixes_catalog where app_id=${appId}::bigint for update`;
        if (!locked[0]?.active || locked[0].provider !== provider) throw new FixesFailure('CATALOG_CHANGED');
        await tx `update fixes_entries set active=false where app_id=${appId}::bigint`;
        for (const f of fixes) {
            const revision = digest(JSON.stringify(f));
            // An upstream ID must not silently move between games.
            await tx `insert into fixes_entries(fix_id,app_id,revision,snapshot) values(${f.id},${appId}::bigint,${revision},${tx.json(JSON.parse(JSON.stringify(f)))})
    on conflict(fix_id) do update set revision=excluded.revision,snapshot=excluded.snapshot,active=true,synced_at=now()
    where fixes_entries.app_id=excluded.app_id`;
        }
        await tx `update fixes_catalog set details_synced_at=now() where app_id=${appId}::bigint`;
    });
}
interface ProviderSession {
    access_token: string;
    refresh_token: string;
}
export function accountId(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
        throw new FixesFailure('ACCOUNT_INPUT');
    return value.toLowerCase();
}
export async function saveProviderSession(sql: Sql, env: Env, input: {
    access_token: unknown;
    refresh_token: unknown;
    expires_at: unknown;
    label?: unknown;
}): Promise<string> {
    if (typeof input.access_token !== 'string' || input.access_token.length < 20 || input.access_token.length > 16384 ||
        typeof input.refresh_token !== 'string' || !input.refresh_token || input.refresh_token.length > 16384 ||
        typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now() ||
        (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 120)))
        throw new FixesFailure('SESSION_INPUT');
    // Verify identity with provider; another login of the same account cannot reset quota.
    const user = await jsonFetch(`${AUTH}/user`, { apikey: FIXES_CONFIG.anonKey, Authorization: `Bearer ${input.access_token}` }) as {
        id?: string;
    };
    const id = accountId(user?.id);
    const bytes = await encryptAsset(new TextEncoder().encode(JSON.stringify({ access_token: input.access_token, refresh_token: input.refresh_token })), env.FIXES_SESSION_KEY_HEX);
    const hex = Buffer.from(bytes).toString('hex');
    await sql `insert into fixes_provider_accounts(account_id,label,session_encrypted,expires_at)
 values(${id}::uuid,${input.label ?? ''},decode(${hex},'hex'),${input.expires_at}::timestamptz)
 on conflict(account_id) do update set label=case when excluded.label='' then fixes_provider_accounts.label else excluded.label end,
 session_encrypted=excluded.session_encrypted,expires_at=excluded.expires_at,status='ready',last_error_code=null,updated_at=now()`;
    // Deliberately preserve usage and blocked_until across login and refresh.
    return id;
}
export async function refreshProviderSession(sql: Sql, env: Env, id: string, automatic = false): Promise<boolean> {
    accountId(id);
    if (!/^[a-f\d]{64}$/i.test(env.FIXES_SESSION_KEY_HEX ?? '')) throw new FixesFailure('SESSION_CONFIG');
    let upstreamStatus: number | undefined;
    const result = await sql.begin(async (tx) => {
        // Recheck under the lock: another queue job may have already rotated the token.
        const rows = automatic
            ? await tx `select encode(session_encrypted,'hex') as encrypted from fixes_provider_accounts
 where account_id=${id}::uuid and (status='ready' or (status='needs_admin' and last_error_code='SESSION_EXPIRED'))
 and expires_at<=now()+interval '30 seconds' for update skip locked`
            : await tx `select encode(session_encrypted,'hex') as encrypted from fixes_provider_accounts where account_id=${id}::uuid for update`;
        if (!rows[0]) {
            if (automatic) return null;
            throw new FixesFailure('SESSION_MISSING');
        }
        let s: ProviderSession;
        try {
            s = JSON.parse(new TextDecoder().decode(await decryptAsset(rows[0].encrypted, env.FIXES_SESSION_KEY_HEX))) as ProviderSession;
            if (typeof s.refresh_token !== 'string' || !s.refresh_token.trim()) throw new Error();
        } catch {
            await tx`update fixes_provider_accounts set status='needs_admin',last_error_code='SESSION_DECRYPT',updated_at=now() where account_id=${id}::uuid`;
            return 'SESSION_DECRYPT';
        }
        const temporaryFailure = async (code: string) => {
            await tx`update fixes_provider_accounts set status=case when status='disabled' then 'disabled' else 'ready' end,last_error_code=${code},
 blocked_until=greatest(blocked_until,now()+interval '60 seconds'),updated_at=now() where account_id=${id}::uuid`;
            return code;
        };
        let res: Response;
        try {
            res = await fetch(`${AUTH}/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: FIXES_CONFIG.anonKey, 'content-type': 'application/json' },
                body: JSON.stringify({ refresh_token: s.refresh_token }), redirect: 'manual', signal: AbortSignal.timeout(8000) });
        }
        catch {
            return temporaryFailure('PROVIDER_NETWORK');
        }
        upstreamStatus = res.status;
        if (!res.ok) {
            await res.body?.cancel();
            if (![400, 401, 403].includes(res.status)) return temporaryFailure('PROVIDER_HTTP');
            await tx `update fixes_provider_accounts set status='needs_admin',last_error_code='REFRESH_REJECTED',updated_at=now() where account_id=${id}::uuid`;
            return 'REFRESH_REJECTED';
        }
        const data = await res.json().catch(() => null) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
        } | null;
        if (!data || typeof data.access_token !== 'string' || !data.access_token.trim() || typeof data.refresh_token !== 'string' || !data.refresh_token.trim() || !Number.isFinite(data.expires_in) || data.expires_in! <= 0)
            return temporaryFailure('REFRESH_FORMAT');
        const blob = await encryptAsset(new TextEncoder().encode(JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token })), env.FIXES_SESSION_KEY_HEX);
        await tx `update fixes_provider_accounts set session_encrypted=decode(${Buffer.from(blob).toString('hex')},'hex'),
 expires_at=now()+${data.expires_in!}*interval '1 second',status=case when status='disabled' then 'disabled' else 'ready' end,last_error_code=null,updated_at=now() where account_id=${id}::uuid`;
        return null;
    });
    if (result) {
        console.warn('fixes_session_refresh_failed', { accountId: id, automatic, code: result, upstreamStatus });
        throw new FixesFailure(result, upstreamStatus);
    }
    console.info('fixes_session_refresh_completed', { accountId: id, automatic, outcome: upstreamStatus === undefined ? 'skipped' : 'refreshed' });
    return upstreamStatus !== undefined;
}
// Downloads reserve one upstream attempt atomically; failed attempts remain counted.
// Metadata reads can request a session without consuming download capacity.
export async function providerAccessToken(sql: Sql, env: Env, allowRefresh = true, excludedAccountIds: string[] = [], reserveDownload = true): Promise<{
    token: string;
    version: string;
    accountId: string;
}> {
    if (!/^[a-f\d]{64}$/i.test(env.FIXES_SESSION_KEY_HEX ?? '')) throw new FixesFailure('SESSION_CONFIG');
    const row = await sql.begin(async (tx) => {
        await tx `update fixes_provider_accounts set status='needs_admin',last_error_code='SESSION_EXPIRED',updated_at=now()
 where status='ready' and expires_at<=now()+interval '30 seconds'`;
        const candidates = await tx `select a.account_id::text,encode(a.session_encrypted,'hex') as encrypted,a.xmin::text as version
 from fixes_provider_accounts a left join fixes_provider_usage u on u.account_id=a.account_id and u.usage_day=(now() at time zone 'Asia/Jakarta')::date
 where a.status='ready' and a.expires_at>now()+interval '30 seconds' and (a.blocked_until is null or a.blocked_until<=now())
 and not (a.account_id::text = any(${excludedAccountIds}::text[]))
 and (${reserveDownload} = false or coalesce(u.download_count,0)<${FIXES_CONFIG.dailyLimit})
 order by coalesce(u.download_count,0),a.account_id for update of a skip locked limit 1`;
        if (!candidates[0])
            return null;
        if (!reserveDownload) return candidates[0];
        const id = candidates[0].account_id;
        const reserved = await tx `insert into fixes_provider_usage(account_id,usage_day,download_count)
 values(${id}::uuid,(now() at time zone 'Asia/Jakarta')::date,1)
 on conflict(account_id,usage_day) do update set download_count=fixes_provider_usage.download_count+1
 where fixes_provider_usage.download_count<${FIXES_CONFIG.dailyLimit} returning download_count`;
        return reserved.length ? candidates[0] : null;
    });
    if (!row) {
        if (allowRefresh) {
            // Bounded pool recovery; no refresh for disabled, blocked or exhausted accounts.
            const expired = await sql `select a.account_id::text from fixes_provider_accounts a
 left join fixes_provider_usage u on u.account_id=a.account_id and u.usage_day=(now() at time zone 'Asia/Jakarta')::date
 where (a.status='ready' or (a.status='needs_admin' and a.last_error_code='SESSION_EXPIRED'))
 and not (a.account_id::text = any(${excludedAccountIds}::text[]))
 and a.expires_at<=now()+interval '30 seconds' and (a.blocked_until is null or a.blocked_until<=now())
 and (${reserveDownload} = false or coalesce(u.download_count,0)<${FIXES_CONFIG.dailyLimit})
 order by coalesce(u.download_count,0),a.account_id limit 4`;
            for (const account of expired) {
                try {
                    await refreshProviderSession(sql, env, account.account_id, true);
                    return await providerAccessToken(sql, env, false, excludedAccountIds, reserveDownload);
                } catch (error) {
                    if (!(error instanceof FixesFailure)) throw error;
                    console.warn('fixes_account_refresh_skipped', { accountId: account.account_id, code: error.code });
                }
            }
        }
        throw new FixesFailure('PROVIDER_UNAVAILABLE');
    }
    try {
        const s = JSON.parse(new TextDecoder().decode(await decryptAsset(row.encrypted, env.FIXES_SESSION_KEY_HEX))) as ProviderSession;
        if (typeof s.access_token !== 'string' || !s.access_token)
            throw new Error();
        console.info(reserveDownload ? 'fixes_account_reserved' : 'fixes_account_metadata_selected', { accountId: row.account_id, dailyLimit: FIXES_CONFIG.dailyLimit });
        return { token: s.access_token, version: row.version, accountId: row.account_id };
    }
    catch {
        await sql `update fixes_provider_accounts set status='needs_admin',last_error_code='SESSION_DECRYPT',updated_at=now() where account_id=${row.account_id}::uuid and xmin::text=${row.version}`;
        console.warn('fixes_account_session_invalid', { accountId: row.account_id, code: 'SESSION_DECRYPT' });
        if (excludedAccountIds.length < 3) return providerAccessToken(sql, env, allowRefresh, [...excludedAccountIds, row.account_id], reserveDownload);
        throw new FixesFailure('SESSION_DECRYPT');
    }
}

/** Rotate only account-specific auth/quota failures. Every attempted account remains counted. */
export async function withProviderAccount<T>(sql: Sql, env: Env, operation: (credential: Awaited<ReturnType<typeof providerAccessToken>>) => Promise<T>): Promise<T> {
    const attempted: string[] = [];
    const recovered = new Set<string>();
    const deadline = Date.now() + 90_000;
    let lastFailure: FixesFailure | undefined;
    for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
        let credential: Awaited<ReturnType<typeof providerAccessToken>>;
        try { credential = await providerAccessToken(sql, env, true, attempted); }
        catch (error) {
            if (error instanceof FixesFailure && error.code === 'PROVIDER_UNAVAILABLE' && lastFailure) throw lastFailure;
            throw error;
        }
        attempted.push(credential.accountId);
        try { return await operation(credential); }
        catch (error) {
            if (!(error instanceof FixesFailure) || !['PROVIDER_AUTH', 'PROVIDER_LIMIT'].includes(error.code)) throw error;
            lastFailure = error;
            if (error.code === 'PROVIDER_AUTH') {
                // An early/revoked access token may still have a usable refresh token.
                // Invalidate only the exact session that received the 401, then refresh once.
                if (error.upstreamStatus === 401 && !recovered.has(credential.accountId)) {
                    recovered.add(credential.accountId);
                    const expired = await sql`update fixes_provider_accounts set status='needs_admin',last_error_code='SESSION_EXPIRED',
 expires_at=least(expires_at,now()),updated_at=now() where account_id=${credential.accountId}::uuid and xmin::text=${credential.version} returning account_id`;
                    if (expired.length) {
                        try {
                            if (await refreshProviderSession(sql, env, credential.accountId, true)) {
                                attempted.splice(attempted.indexOf(credential.accountId), 1);
                                console.info('fixes_account_auth_recovered', { accountId: credential.accountId });
                                continue;
                            }
                        } catch (refreshError) {
                            if (!(refreshError instanceof FixesFailure)) throw refreshError;
                            // Permanent rejection and temporary cooldown are persisted by refresh.
                        }
                    }
                    console.warn('fixes_account_rotating', { accountId: credential.accountId, code: error.code, upstreamStatus: error.upstreamStatus, attempt: attempt + 1 });
                    continue;
                }
                await sql`update fixes_provider_accounts set status='needs_admin',last_error_code='PROVIDER_AUTH',updated_at=now()
 where account_id=${credential.accountId}::uuid and xmin::text=${credential.version}`;
            } else {
                await sql`update fixes_provider_accounts set blocked_until=greatest(blocked_until,((now() at time zone 'Asia/Jakarta')::date+1)::timestamp at time zone 'Asia/Jakarta'),last_error_code='PROVIDER_LIMIT',updated_at=now()
 where account_id=${credential.accountId}::uuid`;
            }
            console.warn('fixes_account_rotating', { accountId: credential.accountId, code: error.code, upstreamStatus: error.upstreamStatus, attempt: attempt + 1 });
        }
    }
    throw lastFailure ?? new FixesFailure('PROVIDER_UNAVAILABLE');
}
export function validateDownloadHosts(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100 || value.some(h => typeof h !== 'string' || h.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(h) || h.toLowerCase() === 'localhost' || h.toLowerCase().endsWith('.localhost')))
        throw new FixesFailure('HOST_INPUT');
    return [...new Set(value.map(h => h.toLowerCase()))];
}
export async function downloadHosts(sql: Sql): Promise<string[]> {
    const rows = await sql `select download_hosts from fixes_provider_config where id=1`;
    return validateDownloadHosts(rows[0]?.download_hosts ?? []);
}
// URLs originate only from the fixed authenticated LuaTools endpoint, never from user input.
export function allowedDownloadUrl(raw: unknown): URL {
    if (typeof raw !== 'string' || raw.length > 16384) throw new FixesFailure('DOWNLOAD_URL');
    let url: URL;
    try { url = new URL(raw); } catch { throw new FixesFailure('DOWNLOAD_URL'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        isIP(host) || host.startsWith('[') || !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|home|lan|arpa|invalid)$/.test(host)) throw new FixesFailure('DOWNLOAD_HOST');
    try { validateDownloadHosts([host]); } catch { throw new FixesFailure('DOWNLOAD_HOST'); }
    return url;
}
export function isPublicDownloadAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a,b,c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
    }
    if (isIP(address) === 6) {
        const [a,b] = address.toLowerCase().split(':').map(v => parseInt(v || '0',16));
        // Global unicast only; exclude transition, special-purpose and documentation ranges.
        return a >= 0x2000 && a < 0x4000 && a !== 0x2002 && a !== 0x3fff &&
            !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
    }
    return false;
}
async function verifiedDownloadUrl(raw: unknown, sql: Sql): Promise<URL> {
    const url = allowedDownloadUrl(raw);
    // Fixed resolver, no bearer or signed package query sent to DNS.
    // https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
    let answers: {Status?: number; TC?: boolean; Answer?: {type:number;data:string}[]}[];
    try {
        answers = await Promise.all(['A','AAAA'].map(type => jsonFetch(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`,
            {accept:'application/dns-json'}) as Promise<{Status?:number;TC?:boolean;Answer?:{type:number;data:string}[]}>));
    } catch { throw new FixesFailure('DOWNLOAD_DNS'); }
    if (answers.some(a => a.Status !== 0 || a.TC || (a.Answer !== undefined && !Array.isArray(a.Answer)))) throw new FixesFailure('DOWNLOAD_DNS');
    const addresses = answers.flatMap(a => a.Answer ?? []).filter(a => a.type === 1 || a.type === 28);
    if (!addresses.length || addresses.some(a => typeof a.data !== 'string' || !isPublicDownloadAddress(a.data))) throw new FixesFailure('DOWNLOAD_HOST');
    // Audit hosts automatically. This list is informational, not a prerequisite or an authorization gate.
    await sql`insert into fixes_provider_config(id,download_hosts) values(1,${sql.json([url.hostname])})
 on conflict(id) do update set download_hosts=case when fixes_provider_config.download_hosts ? ${url.hostname}
 or jsonb_array_length(fixes_provider_config.download_hosts)>=100 then fixes_provider_config.download_hosts
 else fixes_provider_config.download_hosts || excluded.download_hosts end,updated_at=now()`;
    return url;
}
async function requestPackageLink(sql: Sql, env: Env, fixId: string, slot: Slot): Promise<{
    url?: string;
}> {
    if (fixId.startsWith('ryuu:')) {
        if (slot !== 'fix') throw new FixesFailure('RYUU_SLOT');
        if (!env.RYUU_AUTH_CODE?.trim()) throw new FixesFailure('RYUU_AUTH_CONFIG');
        const rows = await sql`select e.app_id,e.snapshot from fixes_entries e join fixes_catalog c on c.app_id=e.app_id
 where e.fix_id=${fixId} and e.active=true and c.active=true and c.provider='ryuu'`;
        const entry = rows[0]?.snapshot as FixEntry | undefined;
        if (!entry || entry.provider !== 'ryuu' || !entry.hasFix || entry.id !== fixId)
            throw new FixesFailure('RYUU_ENTRY');
        const url = ryuuFixUrl(entry.sourceUrl);
        if (fixId !== `ryuu:${rows[0].app_id}:${digest(url.pathname)}` ||
            decodeURIComponent(url.pathname).slice('/fixes/'.length) !== safeFilename(entry.fixFilename, 'fix'))
            throw new FixesFailure('RYUU_ENTRY');
        url.searchParams.set('auth_code', env.RYUU_AUTH_CODE);
        return { url: url.toString() };
    }
    return withProviderAccount(sql, env, async (credential) => {
        return (await jsonFetch(`${API}/api/denuvo/download?fix=${encodeURIComponent(fixId)}&slot=${slot}`, {
            Authorization: `Bearer ${credential.token}`,
        })) as {
            url?: string;
        };
    });
}
export async function fetchFixPackage(sql: Sql, env: Env, fixId: string, slot: Slot): Promise<Response> {
    const data = await requestPackageLink(sql, env, fixId, slot);
    let url = await verifiedDownloadUrl(data?.url, sql);
    // Never send the provider bearer token to package hosts, including redirects.
    for (let redirects = 0; redirects < 4; redirects++) {
        let res: Response;
        try {
            res = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(15 * 60000) });
        }
        catch {
            throw new FixesFailure('DOWNLOAD_NETWORK');
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get('location');
            await res.body?.cancel();
            if (!location)
                throw new FixesFailure('DOWNLOAD_REDIRECT');
            const next = new URL(location, url);
            // A query credential must never be sent to another origin.
            if (fixId.startsWith('ryuu:') && next.origin !== RYUU)
                throw new FixesFailure('RYUU_DOWNLOAD_REDIRECT');
            url = await verifiedDownloadUrl(next.toString(), sql);
            continue;
        }
        if (!res.ok || !res.body) {
            await res.body?.cancel();
            throw new FixesFailure('DOWNLOAD_HTTP');
        }
        return res;
    }
    throw new FixesFailure('DOWNLOAD_REDIRECT');
}
// Admin can inspect the package hostname without downloading bytes or exposing a signed URL.
export async function inspectPackageHost(sql: Sql, env: Env, fixId: string, slot: Slot): Promise<string> {
    const data = await requestPackageLink(sql, env, fixId, slot);
    return (await verifiedDownloadUrl(data.url,sql)).hostname;
}
