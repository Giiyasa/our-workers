import { describe, it, expect, vi, afterEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import worker from "../src/index";
import { allowedDownloadUrl, digest, fetchFixPackage, providerAccessToken, saveProviderSession, refreshProviderSession, validateDownloadHosts, validateFix } from '../src/lib/fixes-provider';
import { packageObjectKey, storePackage } from '../src/lib/fixes-storage';
import { fixesPrepareRoute, fixesDownloadRoute } from '../src/routes/fixes';
import { encryptAsset } from '../src/lib/asset-crypto';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';
vi.mock('../src/lib/session-guard', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/lib/session-guard')>();
    return { ...original, requireSession: vi.fn(async () => ({ ok: true, session: { userId: '12' } })) };
});
afterEach(() => vi.unstubAllGlobals());
const key = '11'.repeat(32), revision = 'a'.repeat(64), token = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function sqlMock(handler: (query: string, values: unknown[]) => unknown) {
    const fn = ((parts: TemplateStringsArray, ...values: unknown[]) => typeof parts === 'string' ? parts : Promise.resolve(handler(parts.join(' ').replace(/\s+/g, ' '), values))) as unknown as Sql;
    Object.assign(fn, { json: (v: unknown) => v, begin: async (cb: (tx: Sql) => unknown) => cb(fn), end: async () => { } });
    return fn;
}
const input = { fixId: 'fixture', revision, slot: 'fix' as const };
const snap = {
    id: 'fixture',
    title: 'Fixture',
    description: 'text',
    tags: [],
    hasManifest: true,
    hasFix: true,
    manifestFilename: '620.zip',
    fixFilename: '620_fix.zip',
};
const env = {
    R2_ENDPOINT: 'https://storage.test',
    R2_ACCESS_KEY_ID: 'fixture',
    R2_SECRET_ACCESS_KEY: 'fixture',
    R2_BUCKET: 'fixture',
    FIXES_SESSION_KEY_HEX: key,
} as Env;
const context = (path: string) => ({
    env,
    request: new Request(`https://worker.test${path}`),
    url: new URL(`https://worker.test${path}`),
    params: [],
    executionCtx: { waitUntil: () => { } },
}) as unknown as RouteContext;
async function sessionRow(valid = true) {
    const bytes = await encryptAsset(new TextEncoder().encode(JSON.stringify({ access_token: 'fixture-provider-token', refresh_token: 'fixture-refresh' })), key);
    return { account_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: '1', encrypted: Buffer.from(bytes).toString('hex'), status: 'ready', valid };
}
const SESSION = {
    'x-access-token': 'b7a3f5c1d9e24680a1b2c3d4e5f60718',
    'x-user-id': '12',
    'x-device-id': 'b7a3f5c1d9e24680a1b2c3d4e5f60718',
};
describe('Fixes HTTP gates', () => {
    it('requires application auth before DB', async () => {
        expect((await SELF.fetch('https://worker.test/api/fixes')).status).toBe(401);
    });
    it('rejects invalid package identities before DB', async () => {
        const res = await SELF.fetch('https://worker.test/api/fixes/prepare', {
            method: 'POST',
            headers: { ...SESSION, 'content-type': 'application/json' },
            body: JSON.stringify({ fix_id: 'fixture', revision: '../escape', slot: 'fix' }),
        });
        expect(res.status).toBe(400);
    });
    it('admin refresh cannot be invoked with an ordinary application session', async () => {
        const res = await SELF.fetch('https://worker.test/api/admin/fixes/refresh', { method: 'POST', headers: SESSION });
        expect(res.status).toBe(401);
    });
});
describe('provider credentials and hosts', () => {
    it('expired provider session stops before network and exposes no token', async () => {
        const row = await sessionRow(false);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(providerAccessToken(sqlMock(q => q.includes('select a.account_id') ? [] : []), env)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects unconfigured, HTTP, credential-bearing and alternate-port hosts', () => {
        for (const url of [
            'http://packages.test/a',
            'https://evil.test/a',
            'https://user:pass@packages.test/a',
            'https://packages.test:8443/a',
            'https://127.0.0.1/a',
        ])
            expect(() => allowedDownloadUrl(url, ['packages.test'])).toThrow();
        expect(allowedDownloadUrl('https://packages.test/a?signature=fixture', ['packages.test']).hostname).toBe('packages.test');
    });
    it('sends bearer only to LuaTools and stops unsafe redirects', async () => {
        const row = await sessionRow();
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ url: 'https://packages.test/file' }))
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } }));
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sqlMock(q => q.includes('select download_hosts') ? [{ download_hosts: ['packages.test'] }] : [row]), env, 'fixture', 'fix')).rejects.toMatchObject({ code: 'DOWNLOAD_HOST' });
        expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-provider-token');
        expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('permits missing upstream filenames for original fallback naming', () => {
        expect(validateFix({ ...snap, manifestFilename: null, fixFilename: null }).hasFix).toBe(true);
        expect(() => validateFix({ ...snap, fixFilename: '../bad.zip' })).toThrow();
    });
});
describe('R2 cache', () => {
    it('ready cache prepares download without contacting LuaTools', async () => {
        const key = packageObjectKey('fixture', revision, 'fix', token);
        const fetcher = vi.fn().mockResolvedValue(new Response(null));
        vi.stubGlobal('fetch', fetcher);
        const sql = sqlMock((query) => query.includes('access_role_code')
            ? [{ access_role_code: 3 }]
            : query.includes('select e.app_id')
                ? [{ app_id: 620, snapshot: snap, revision }]
                : query.includes('fixes_package_jobs')
                    ? [{ status: 'ready', r2_object_key: key, filename: '620_fix.zip', sha256: revision, size_bytes: 8 }]
                    : []);
        const res = await fixesPrepareRoute.handle(context('/api/fixes/prepare'), input, sql);
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).status).toBe('ready');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(new URL(String(fetcher.mock.calls[0][0])).hostname).toBe('storage.test');
        expect(fetcher.mock.calls[0][1].method).toBe('HEAD');
    });
    it('a storage outage does not start a provider job', async () => {
        const key = packageObjectKey('fixture', revision, 'fix', token);
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', fetcher);
        let wrote = false;
        const sql = sqlMock((query) => {
            if (query.includes('insert into fixes_package_jobs'))
                wrote = true;
            return query.includes('access_role_code')
                ? [{ access_role_code: 3 }]
                : query.includes('select e.app_id')
                    ? [{ app_id: 620, snapshot: snap, revision }]
                    : query.includes('select *,')
                        ? [{ status: 'ready', r2_object_key: key }]
                        : [];
        });
        const res = await fixesPrepareRoute.handle(context('/api/fixes/prepare'), input, sql);
        expect(res.status).toBe(503);
        expect(wrote).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('requires owned game for role 4 before storage/provider access', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const sql = sqlMock((query) => query.includes('access_role_code')
            ? [{ access_role_code: 4 }]
            : query.includes('select e.app_id')
                ? [{ app_id: 620, snapshot: snap, revision }]
                : []);
        const res = await fixesPrepareRoute.handle(context('/api/fixes/prepare'), input, sql);
        expect(res.status).toBe(403);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('download forwards cached bytes without any provider/user quota writes', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]))));
        const sql = sqlMock((query) => {
            calls.push(query);
            return query.includes('access_role_code')
                ? [{ access_role_code: 3 }]
                : query.includes('select e.app_id')
                    ? [{ app_id: 620, snapshot: snap, revision }]
                    : query.includes('select *,')
                        ? [
                            {
                                status: 'ready',
                                r2_object_key: packageObjectKey('fixture', revision, 'fix', token),
                                filename: '620_fix.zip',
                                size_bytes: 4,
                                sha256: revision,
                            },
                        ]
                        : query.includes('fixes_download_usage')
                            ? [{ user_id: 12 }]
                            : [];
        });
        const res = await fixesDownloadRoute.handle(context('/api/fixes/package'), input, sql);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(calls.some((q) => q.includes('fixes_download_usage') || q.includes('fixes_provider_usage') || q.includes('fixes_provider_accounts'))).toBe(false);
        expect(calls.some((q) => q.includes('free_claim_game') || q.includes('user_download_daily_usage'))).toBe(false);
    });
    it('streamed multipart upload hashes all bytes and publishes only after completion', async () => {
        const bytes = new Uint8Array(9 * 1024 * 1024);
        bytes.set([0x50, 0x4b, 3, 4]);
        let parts = 0;
        const methods: string[] = [];
        const fetcher = vi.fn(async (raw: string, init: RequestInit) => {
            const url = new URL(String(raw));
            methods.push(init.method!);
            if (url.searchParams.has('uploads'))
                return new Response('<InitiateMultipartUploadResult><UploadId>fixture</UploadId></InitiateMultipartUploadResult>');
            if (url.searchParams.has('partNumber')) {
                parts++;
                return new Response(null, { headers: { etag: `"part${parts}"` } });
            }
            return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
        });
        vi.stubGlobal('fetch', fetcher);
        const heartbeat = vi.fn(async () => { });
        const result = await storePackage(env, packageObjectKey('fixture', revision, 'fix', token), new Response(bytes), 'fix.zip', heartbeat);
        expect(parts).toBe(2);
        expect(result).toEqual({ size: bytes.length, sha256: digest(bytes) });
        expect(methods).toEqual(['POST', 'PUT', 'PUT', 'POST']);
        expect(heartbeat).toHaveBeenCalled();
    });
    it('aborts multipart upload for HTML masquerading as a package', async () => {
        const methods: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_: string, init: RequestInit) => {
            methods.push(init.method!);
            return init.method === 'POST'
                ? new Response('<InitiateMultipartUploadResult><UploadId>fixture</UploadId></InitiateMultipartUploadResult>')
                : new Response(null);
        }));
        await expect(storePackage(env, packageObjectKey('fixture', revision, 'fix', token), new Response('<html>error</html>'), 'fix.zip', async () => { })).rejects.toMatchObject({ code: 'PACKAGE_FORMAT' });
        expect(methods).toEqual(['POST', 'DELETE']);
    });
});
describe('queue malformed messages', () => {
    it('acknowledges null payload without DB or provider access', async () => {
        const ack = vi.fn(), retry = vi.fn();
        await worker.queue({ messages: [{ body: null, ack, retry }] } as any, {} as Env);
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
    });
});
describe('multiaccount provider controls', () => {
    it('uses verified provider identity for repeated login and never rewrites usage', async () => {
        const queries: string[] = [];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: token })));
        const sql = sqlMock(q => { queries.push(q); return []; });
        const id = await saveProviderSession(sql, env, { access_token: 'synthetic-access-token-long', refresh_token: 'synthetic-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), label: 'Main' });
        expect(id).toBe(token);
        expect(queries.some(q => q.includes('on conflict(account_id)'))).toBe(true);
        expect(queries.some(q => q.includes('fixes_provider_usage'))).toBe(false);
        expect(queries.some(q => q.includes('blocked_until='))).toBe(false);
    });
    it('rejects unverified identity before writing a session', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'invalid' })));
        let writes = 0;
        await expect(saveProviderSession(sqlMock(() => { writes++; return []; }), env, { access_token: 'synthetic-access-token-long', refresh_token: 'synthetic-refresh', expires_at: new Date(Date.now() + 3600000).toISOString() })).rejects.toMatchObject({ code: 'ACCOUNT_INPUT' });
        expect(writes).toBe(0);
    });
    it('marks only the failed account and session version on upstream auth rejection', async () => {
        const row = await sessionRow();
        const calls: {
            q: string;
            v: unknown[];
        }[] = [];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
        await expect(fetchFixPackage(sqlMock((q, v) => { calls.push({ q, v }); return q.includes('select download_hosts') ? [{ download_hosts: ['packages.test'] }] : [row]; }), env, 'fixture', 'fix')).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
        const invalidation = calls.find(c => c.q.includes("last_error_code='PROVIDER_AUTH'"))!;
        expect(invalidation.q).toContain('xmin::text=');
        expect(invalidation.v).toEqual([row.account_id, row.version]);
    });
    it('counts an upstream limit response and blocks that account until next WIB day', async () => {
        const row = await sessionRow();
        const calls: string[] = [];
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sqlMock(q => { calls.push(q); return q.includes('select download_hosts') ? [{ download_hosts: ['packages.test'] }] : [row]; }), env, 'fixture', 'fix')).rejects.toMatchObject({ code: 'PROVIDER_LIMIT' });
        expect(calls.some(q => q.includes('insert into fixes_provider_usage'))).toBe(true);
        expect(calls.some(q => q.includes('blocked_until=') && q.includes('Asia/Jakarta'))).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('does not consume quota or request a link before package hosts are configured', async () => {
        const queries: string[] = [];
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sqlMock(q => { queries.push(q); return []; }), env, 'fixture', 'fix')).rejects.toMatchObject({ code: 'DOWNLOAD_HOST' });
        expect(queries).toHaveLength(1);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('admin refresh targets one account without clearing daily usage or provider block', async () => {
        const row = await sessionRow();
        const calls: {
            q: string;
            v: unknown[];
        }[] = [];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600 })));
        await refreshProviderSession(sqlMock((q, v) => { calls.push({ q, v }); return [row]; }), env, token);
        expect(calls.every(c => !c.q.includes('fixes_provider_usage') && !c.q.includes('blocked_until='))).toBe(true);
        expect(calls.filter(c => c.q.includes('account_id=')).every(c => c.v.includes(token))).toBe(true);
    });
    it('host settings reject IPs, URLs, wildcards and localhost', () => {
        for (const h of ['127.0.0.1', 'https://packages.test', '*.packages.test', 'localhost', 'a.localhost'])
            expect(() => validateDownloadHosts([h])).toThrow();
        expect(validateDownloadHosts(['Packages.test', 'packages.test'])).toEqual(['packages.test']);
    });
});
