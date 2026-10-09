import { FIXES_CONFIG } from '../fixes-config.mjs';
import { TABLE_USER, TABLE_USER_LIST_GAME } from '../config';
import { readJsonBody } from '../lib/body';
import { fail, json } from '../lib/http';
import { preflightSession, requireSession, sessionFailStatus } from '../lib/session-guard';
import type { DbRoute, RouteContext } from '../lib/types';
import type { Sql } from '../lib/db';
import { FixesFailure, accountId, validateDownloadHosts, inspectPackageHost, syncListings, syncDetails, saveProviderSession, refreshProviderSession, safeFilename, type Slot, type FixEntry, } from '../lib/fixes-provider';
import { startFixesJob } from '../lib/fixes-jobs';
import { readPackage } from '../lib/fixes-storage';
const unavailable = () => fail(503, 'Paket sementara belum tersedia. Coba lagi nanti.', 'FIXES_UNAVAILABLE');
async function access(ctx: RouteContext, sql: Sql, appId?: number): Promise<string | Response> {
    const check = await requireSession(sql, ctx.env, ctx.request, ctx.request.headers.get('x-user-id'));
    if (!check.ok)
        return fail(sessionFailStatus(check.code), check.error, check.code);
    const userId = check.session.userId;
    const users = await sql `select access_role_code from ${sql(TABLE_USER)} where user_id=${userId}::bigint`;
    const role = Number(users[0]?.access_role_code);
    if (![2, 3, 4].includes(role))
        return fail(403, 'Akun tidak memiliki akses Fixes.', 'FIXES_FORBIDDEN');
    if (appId && role === 4) {
        const owned = await sql `select 1 from ${sql(TABLE_USER_LIST_GAME)} where user_id=${userId}::bigint and app_id_buy=${appId}::bigint limit 1`;
        if (!owned.length)
            return fail(403, 'Tambahkan game ke library melalui claim terlebih dahulu.', 'FIXES_NOT_OWNED');
    }
    return userId;
}
function sessionPrepare(ctx: RouteContext) {
    const pre = preflightSession(ctx.request, ctx.env);
    return pre.ok ? { input: undefined } : fail(pre.status, pre.error, pre.code);
}
export const fixesListRoute: DbRoute = {
    method: 'GET',
    path: '/api/fixes',
    token: 'none',
    requiresDb: true,
    prepare: sessionPrepare,
    handle: async (ctx, _, sql) => {
        const user = await access(ctx, sql);
        if (user instanceof Response)
            return user;
        const page = Math.max(1, Math.min(10000, Number(ctx.url.searchParams.get('page')) || 1));
        const limit = 24, q = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 160), tag = (ctx.url.searchParams.get('tag') ?? '').slice(0, 160);
        const idsRaw = ctx.url.searchParams.get('installed');
        if (idsRaw && (idsRaw.length > 30000 || !/^\d+(,\d+)*$/.test(idsRaw)))
            return fail(400, 'Daftar game terpasang tidak valid.');
        const installed = idsRaw ? idsRaw.split(',').map(Number) : [];
        if (installed.some((id) => !Number.isSafeInteger(id) || id <= 0))
            return fail(400, 'AppID tidak valid.');
        // Explicit validated array text: postgres.js fetch_types:false cannot infer empty bigint arrays.
        const installedArray = `{${installed.join(',')}}`;
        const rows = await sql `select app_id::text as appid,name,header_image,fix_count as "fixCount",tags,count(*) over()::int as total
   from fixes_catalog where active=true and (${q}='' or name ilike ${'%' + q + '%'} or app_id::text=${q})
   and (${tag}='' or exists(select 1 from jsonb_array_elements(tags) t where t->>'slug'=${tag} or t->>'id'=${tag}))
   and (${idsRaw === null} or app_id=any(${installedArray}::bigint[])) order by lower(name),app_id limit ${limit} offset ${(Math.floor(page) - 1) * limit}`;
        const tags = await sql `select distinct t as tag from fixes_catalog,jsonb_array_elements(tags) t where active=true`;
        return json({
            ok: true,
            games: rows.map(({ total, ...g }) => g),
            tags: tags.map((r) => r.tag),
            page: Math.floor(page),
            total: rows[0]?.total ?? 0,
            hasMore: Math.floor(page) * limit < (rows[0]?.total ?? 0),
        });
    },
};
export const fixesDetailRoute: DbRoute<number> = {
    method: 'GET',
    path: '/api/fixes/:app_id',
    pattern: /^\/api\/fixes\/(\d+)$/,
    token: 'none',
    requiresDb: true,
    prepare: (ctx) => {
        const pre = sessionPrepare(ctx);
        if (pre instanceof Response)
            return pre;
        const id = Number(ctx.params[0]);
        return Number.isSafeInteger(id) && id > 0 ? { input: id } : fail(400, 'AppID tidak valid.');
    },
    handle: async (ctx, appId, sql) => {
        const user = await access(ctx, sql);
        if (user instanceof Response)
            return user;
        const games = await sql `select app_id::text as appid,name,header_image,tags,details_synced_at,coalesce(details_synced_at>now()-interval '1 hour',false) as fresh from fixes_catalog where app_id=${appId}::bigint and active=true`;
        if (!games[0])
            return fail(404, 'Game tidak ada di katalog Fixes.');
        if (!games[0].fresh) {
            try {
                await syncDetails(sql, appId);
            }
            catch {
                if (!games[0].details_synced_at)
                    return unavailable();
            }
        }
        const entries = await sql `select snapshot,revision from fixes_entries where app_id=${appId}::bigint and active=true order by synced_at desc,fix_id`;
        return json({
            ok: true,
            appid: String(appId),
            name: games[0].name,
            fixes: entries.map((r) => ({ ...r.snapshot, revision: r.revision })),
        });
    },
};
interface PackageInput {
    fixId: string;
    revision: string;
    slot: Slot;
}
function packageInput(value: Record<string, unknown>): PackageInput | Response {
    if (typeof value.fix_id !== 'string' ||
        !value.fix_id ||
        value.fix_id.length > 160 ||
        typeof value.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.revision) ||
        !['manifest', 'fix'].includes(String(value.slot)))
        return fail(400, 'Identitas paket tidak valid.');
    return { fixId: value.fix_id, revision: value.revision, slot: value.slot as Slot };
}
async function packageAccess(ctx: RouteContext, sql: Sql, input: PackageInput) {
    const user = await access(ctx, sql);
    if (user instanceof Response)
        return user;
    const rows = await sql `select e.app_id,e.snapshot,e.revision from fixes_entries e join fixes_catalog c on c.app_id=e.app_id where e.fix_id=${input.fixId} and e.active=true and c.active=true`;
    const entry = rows[0];
    if (!entry)
        return fail(404, 'Paket tidak tersedia.');
    if (entry.revision !== input.revision)
        return fail(409, 'Detail paket berubah. Muat ulang detail game.', 'FIXES_CHANGED');
    const granted = await access(ctx, sql, Number(entry.app_id));
    if (granted instanceof Response)
        return granted;
    const snapshot = entry.snapshot as FixEntry;
    if (!(input.slot === 'fix' ? snapshot.hasFix : snapshot.hasManifest))
        return fail(404, 'Jenis paket tidak tersedia.');
    return {
        userId: granted,
        appId: Number(entry.app_id),
        filename: safeFilename(input.slot === 'fix' ? (snapshot.fixFilename ?? `${entry.app_id}_fix.zip`) : (snapshot.manifestFilename ?? `${entry.app_id}.zip`), input.slot),
    };
}
async function job(sql: Sql, input: PackageInput) {
    const rows = await sql `select *,lease_expires_at>now() as live,coalesce(next_retry_at>now(),false) as cooling from fixes_package_jobs where fix_id=${input.fixId} and revision=${input.revision} and slot=${input.slot}`;
    return rows[0];
}
export const fixesPrepareRoute: DbRoute<PackageInput> = {
    method: 'POST',
    path: '/api/fixes/prepare',
    token: 'none',
    requiresDb: true,
    prepare: async (ctx) => {
        const pre = sessionPrepare(ctx);
        if (pre instanceof Response)
            return pre;
        const body = await readJsonBody(ctx.request);
        if (body instanceof Response)
            return body;
        const input = packageInput(body.value);
        return input instanceof Response ? input : { input };
    },
    handle: async (ctx, input, sql) => {
        try {
            const allowed = await packageAccess(ctx, sql, input);
            if (allowed instanceof Response)
                return allowed;
            const current = await job(sql, input);
            if (current?.status === 'ready') {
                const head = await readPackage(ctx.env, current.r2_object_key, 'HEAD');
                await head.body?.cancel();
                if (head.ok) {
                    const query = new URLSearchParams({ fix_id: input.fixId, revision: input.revision, slot: input.slot });
                    return json({
                        ok: true,
                        status: 'ready',
                        download_path: `/api/fixes/package?${query}`,
                        filename: current.filename,
                        sha256: current.sha256,
                        size: Number(current.size_bytes),
                        app_id: allowed.appId,
                    });
                }
                if (head.status !== 404)
                    return unavailable();
            }
            if (current?.status === 'failed' && current.cooling)
                return unavailable();
            if (!(current?.status === 'processing' && current.live))
                await startFixesJob(sql, ctx.env, input.fixId, input.revision, input.slot, allowed.appId, allowed.filename);
            return json({ ok: true, status: 'processing', retry_after_seconds: 3 }, 202);
        }
        catch (error) {
            console.error('fixes_prepare_failed', { code: error instanceof FixesFailure ? error.code : 'FIXES_FAILED' });
            return unavailable();
        }
    },
};
export const fixesDownloadRoute: DbRoute<PackageInput> = {
    method: 'GET',
    path: '/api/fixes/package',
    token: 'none',
    requiresDb: true,
    prepare: (ctx) => {
        const pre = sessionPrepare(ctx);
        if (pre instanceof Response)
            return pre;
        const input = packageInput(Object.fromEntries(ctx.url.searchParams));
        return input instanceof Response ? input : { input };
    },
    handle: async (ctx, input, sql) => {
        try {
            const allowed = await packageAccess(ctx, sql, input);
            if (allowed instanceof Response)
                return allowed;
            const current = await job(sql, input);
            if (current?.status !== 'ready')
                return unavailable();
            const source = await readPackage(ctx.env, current.r2_object_key);
            if (!source.ok || !source.body) {
                await source.body?.cancel();
                return unavailable();
            }
            // Serving cached R2 bytes consumes no upstream provider account quota.
            return new Response(source.body, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'content-length': String(current.size_bytes),
                    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(current.filename)}`,
                    'x-package-sha256': current.sha256,
                    'cache-control': 'no-store',
                },
            });
        }
        catch (error) {
            console.error('fixes_download_failed', { code: error instanceof FixesFailure ? error.code : 'FIXES_FAILED' });
            return unavailable();
        }
    },
};
// Existing WRITE_TOKEN gate protects admin-only endpoints. Responses never return session secrets.
export const fixesAdminSessionRoute: DbRoute<Record<string, unknown>> = {
    method: 'POST',
    path: '/api/admin/fixes/session',
    token: 'write',
    requiresDb: true,
    prepare: async (ctx) => {
        const body = await readJsonBody(ctx.request);
        return body instanceof Response ? body : { input: body.value };
    },
    handle: async (ctx, input, sql) => {
        try {
            const id = await saveProviderSession(sql, ctx.env, {
                access_token: input.access_token,
                refresh_token: input.refresh_token,
                expires_at: input.expires_at,
                label: input.label,
            });
            return json({ ok: true, account_id: id });
        }
        catch (e) {
            return fail(400, 'Sesi provider tidak dapat disimpan.', e instanceof FixesFailure ? e.code : 'SESSION_CONFIG');
        }
    },
};
export const fixesAdminRefreshRoute: DbRoute<string> = {
    method: 'POST',
    path: '/api/admin/fixes/refresh',
    token: 'write',
    requiresDb: true,
    prepare: async (ctx) => { const body = await readJsonBody(ctx.request); if (body instanceof Response)
        return body; try {
        return { input: accountId(body.value.account_id) };
    }
    catch {
        return fail(400, 'Account ID tidak valid.');
    } },
    handle: async (ctx, id, sql) => {
        try {
            await refreshProviderSession(sql, ctx.env, id);
            return json({ ok: true });
        }
        catch (e) {
            return fail(503, 'Admin perlu memperbarui sesi provider.', e instanceof FixesFailure ? e.code : 'REFRESH_FAILED');
        }
    },
};
export const fixesAdminStatusRoute: DbRoute = {
    method: 'GET',
    path: '/api/admin/fixes/status',
    token: 'write',
    requiresDb: true,
    handle: async (_, __, sql) => {
        const session = await sql `select a.account_id::text,a.label,a.status,a.expires_at,a.expires_at>now() as valid,a.blocked_until,a.last_error_code,a.updated_at,
 coalesce(u.download_count,0) as downloads_today,greatest(0,${FIXES_CONFIG.dailyLimit}-coalesce(u.download_count,0)) as remaining_today
 from fixes_provider_accounts a left join fixes_provider_usage u on u.account_id=a.account_id and u.usage_day=(now() at time zone 'Asia/Jakarta')::date order by a.label,a.account_id`;
        const jobs = await sql `select fix_id,revision,slot,status,error_code,attempts,updated_at from fixes_package_jobs order by updated_at desc limit 100`;
        return json({ ok: true, accounts: session, daily_limit: FIXES_CONFIG.dailyLimit, quota_timezone: "Asia/Jakarta", jobs });
    },
};
export const fixesAdminSyncRoute: DbRoute<number | null> = {
    method: 'POST',
    path: '/api/admin/fixes/sync',
    token: 'write',
    requiresDb: true,
    prepare: async (ctx) => {
        const body = await readJsonBody(ctx.request);
        if (body instanceof Response)
            return body;
        const id = body.value.app_id;
        return id === undefined
            ? { input: null }
            : Number.isSafeInteger(Number(id)) && Number(id) > 0
                ? { input: Number(id) }
                : fail(400, 'AppID tidak valid.');
    },
    handle: async (_, appId, sql) => {
        try {
            if (appId) {
                const game = await sql `select 1 from fixes_catalog where app_id=${appId}::bigint`;
                if (!game.length)
                    return fail(404, 'Sinkronkan katalog terlebih dahulu.');
                await syncDetails(sql, appId);
                return json({ ok: true });
            }
            return json({ ok: true, count: await syncListings(sql) });
        }
        catch (e) {
            return fail(503, 'Sinkronisasi provider gagal.', e instanceof FixesFailure ? e.code : 'SYNC_FAILED');
        }
    },
};
export const fixesAdminHostRoute: DbRoute<{
    fixId: string;
    slot: Slot;
}> = {
    method: 'POST',
    path: '/api/admin/fixes/host',
    token: 'write',
    requiresDb: true,
    prepare: async (ctx) => {
        const body = await readJsonBody(ctx.request);
        if (body instanceof Response)
            return body;
        const input = body.value;
        return typeof input.fix_id === 'string' &&
            input.fix_id.length > 0 &&
            input.fix_id.length <= 160 &&
            ['manifest', 'fix'].includes(String(input.slot))
            ? { input: { fixId: input.fix_id, slot: input.slot as Slot } }
            : fail(400, 'Identitas paket tidak valid.');
    },
    handle: async (ctx, input, sql) => {
        try {
            return json({ ok: true, hostname: await inspectPackageHost(sql, ctx.env, input.fixId, input.slot) });
        }
        catch (e) {
            return fail(503, 'Host paket tidak dapat diperiksa.', e instanceof FixesFailure ? e.code : 'HOST_FAILED');
        }
    },
};
export const fixesAdminInvalidateRoute: DbRoute<{
    fixId: string;
    slot: Slot;
}> = {
    method: 'POST',
    path: '/api/admin/fixes/invalidate',
    token: 'write',
    requiresDb: true,
    prepare: fixesAdminHostRoute.prepare,
    handle: async (_, input, sql) => {
        const rows = await sql `update fixes_package_jobs j set status='failed',error_code='ADMIN_INVALIDATED',next_retry_at=now(),updated_at=now()
   from fixes_entries e where j.fix_id=e.fix_id and j.revision=e.revision and j.fix_id=${input.fixId} and j.slot=${input.slot}
   and j.status<>'processing' returning j.fix_id`;
        return json({ ok: true, invalidated: rows.length > 0 });
    },
};
export const fixesAdminConfigRoute: DbRoute<string[]> = {
    method: 'POST', path: '/api/admin/fixes/config', token: 'write', requiresDb: true,
    prepare: async (ctx) => {
        const body = await readJsonBody(ctx.request);
        if (body instanceof Response)
            return body;
        try {
            return { input: validateDownloadHosts(body.value.download_hosts) };
        }
        catch {
            return fail(400, 'Hostname tidak valid.');
        }
    },
    handle: async (_, hosts, sql) => {
        await sql `insert into fixes_provider_config(id,download_hosts) values(1,${sql.json(hosts)})
 on conflict(id) do update set download_hosts=excluded.download_hosts,updated_at=now()`;
        return json({ ok: true, download_hosts: hosts });
    }
};
export const fixesAdminAccountRoute: DbRoute<{
    id: string;
    enabled: boolean;
}> = {
    method: 'POST', path: '/api/admin/fixes/account', token: 'write', requiresDb: true,
    prepare: async (ctx) => {
        const body = await readJsonBody(ctx.request);
        if (body instanceof Response)
            return body;
        try {
            if (typeof body.value.enabled !== 'boolean')
                throw Error();
            return { input: { id: accountId(body.value.account_id), enabled: body.value.enabled } };
        }
        catch {
            return fail(400, 'Pengaturan akun tidak valid.');
        }
    },
    handle: async (_, input, sql) => {
        const rows = await sql `update fixes_provider_accounts set status=case when ${input.enabled} then
 case when expires_at>now()+interval '30 seconds' then 'ready' else 'needs_admin' end else 'disabled' end,updated_at=now()
 where account_id=${input.id}::uuid returning account_id`;
        return rows.length ? json({ ok: true }) : fail(404, 'Akun tidak ditemukan.');
    }
};
export const fixesRoutes = [
    fixesListRoute,
    fixesDownloadRoute,
    fixesPrepareRoute,
    fixesDetailRoute,
    fixesAdminSessionRoute,
    fixesAdminRefreshRoute,
    fixesAdminStatusRoute,
    fixesAdminSyncRoute,
    fixesAdminHostRoute,
    fixesAdminInvalidateRoute,
    fixesAdminConfigRoute,
    fixesAdminAccountRoute,
];
