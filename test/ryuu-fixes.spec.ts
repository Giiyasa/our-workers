import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest, fetchFixPackage, safeFilename, syncDetails, syncListings } from '../src/lib/fixes-provider';
import { validatePackagePrefix } from '../src/lib/fixes-storage';
import { parseRyuuCatalog, ryuuFixUrl } from '../src/lib/ryuu-fixes';
import { fixesDetailRoute } from '../src/routes/fixes';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';

vi.mock('../src/lib/session-guard', async importOriginal => ({
    ...await importOriginal<typeof import('../src/lib/session-guard')>(),
    requireSession: vi.fn(async () => ({ ok: true, session: { userId: '12' } })),
}));
afterEach(() => vi.unstubAllGlobals());
const ryuuGame = (appid = '730') => ({ appid, name: 'Ryuu fixture', fixes: [{
    href: 'https://generator.ryuu.lol/fixes/fixture.zip', filename: 'fixture.zip', size: '1 MB', badges: ['Tested'],
}] });
const primary = { appid: '620', name: 'Primary fixture', fixCount: 1, tags: [] };
function sqlMock(handler: (query: string, values: unknown[]) => unknown): Sql {
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => typeof parts === 'string' ? parts
        : Promise.resolve(handler(parts.join(' ').replace(/\s+/g, ' '), values))) as unknown as Sql;
    Object.assign(sql, { json: (value: unknown) => value, begin: async (cb: (tx: Sql) => unknown) => cb(sql), end: async () => {} });
    return sql;
}
const entry = () => parseRyuuCatalog([ryuuGame()])[0].fixes[0];

describe('Ryuu Fixes catalog', () => {
    it('merges by numeric AppID and always keeps the primary listing on duplicates', async () => {
        const fetcher = vi.fn(async (raw: string) => new URL(String(raw)).hostname === 'lua.tools'
            ? Response.json({ games: [primary] }) : Response.json([ryuuGame('0620'), ryuuGame()]));
        vi.stubGlobal('fetch', fetcher);
        const saved: any[] = [];
        const count = await syncListings(sqlMock((q, v) => { if (q.includes('jsonb_to_recordset')) saved.push(...JSON.parse(v[0] as string)); return []; }));
        expect(count).toBe(2);
        expect(saved.map(g => [g.app_id, g.name, g.provider])).toEqual([[620, primary.name, 'luatools'], [730, 'Ryuu fixture', 'ryuu']]);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('does not treat a primary outage as missing games or write a partial snapshot', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
        vi.stubGlobal('fetch', fetcher);
        let writes = 0;
        await expect(syncListings(sqlMock(() => { writes++; return []; }))).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
        expect(writes).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('preserves the current catalog when Ryuu is unavailable or malformed', async () => {
        for (const body of [null, { games: [] }]) {
            vi.stubGlobal('fetch', vi.fn(async (raw: string) => new URL(String(raw)).hostname === 'lua.tools'
                ? Response.json({ games: [primary] }) : body === null ? new Response(null, { status: 503 }) : Response.json(body)));
            let writes = 0;
            await expect(syncListings(sqlMock(() => { writes++; return []; }))).rejects.toThrow();
            expect(writes).toBe(0);
        }
    });
    it('keeps stable namespaced IDs and badges for both ZIP and RAR', () => {
        const game = ryuuGame();
        game.fixes.push({ ...game.fixes[0] }, { ...game.fixes[0], filename: 'unsupported.rar', href: 'https://generator.ryuu.lol/fixes/unsupported.rar' });
        const parsed = parseRyuuCatalog([game])[0];
        expect(parsed.fixCount).toBe(2);
        expect(parsed.fixes[0]).toMatchObject({ id: `ryuu:730:${digest('/fixes/fixture.zip')}`, hasFix: true, hasManifest: false });
        expect(parsed.tags[0].name).toBe('Tested');
        expect(parsed.fixes[1]).toMatchObject({ hasFix: true, hasManifest: false, fixFilename: 'unsupported.rar' });
        expect(parseRyuuCatalog([{ ...game, fixes: [{ ...game.fixes[2], filename: 'unsupported.7z' }] }])).toEqual([]);
    });
    it('rejects duplicate game IDs and unsafe or mismatched package paths', () => {
        expect(() => parseRyuuCatalog([ryuuGame(), ryuuGame('0730')])).toThrow();
        for (const href of ['https://evil.test/fixes/fixture.zip', 'https://generator.ryuu.lol/fixes/other.zip',
            'https://generator.ryuu.lol/fixes/fixture.zip?auth_code=secret', 'https://generator.ryuu.lol/fixes/a%2Fb.zip'])
            expect(() => parseRyuuCatalog([{ ...ryuuGame(), fixes: [{ ...ryuuGame().fixes[0], href }] }])).toThrow();
        expect(() => ryuuFixUrl('https://user:secret@generator.ryuu.lol/fixes/fixture.zip')).toThrow();
    });
    it('uses an AppID label for an empty upstream game name and revises metadata when size changes', () => {
        expect(parseRyuuCatalog([{ ...ryuuGame(), name: '' }])[0].name).toBe('Game 730');
        const changed = ryuuGame(); changed.fixes[0].size = '2 MB';
        expect(digest(JSON.stringify(parseRyuuCatalog([changed])[0].fixes[0]))).not.toBe(digest(JSON.stringify(entry())));
    });
});

describe('ZIP and RAR package validation', () => {
    const rar4 = new Uint8Array([0x52,0x61,0x72,0x21,0x1a,0x07,0x00]);
    const rar5 = new Uint8Array([0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00]);
    const zip = new Uint8Array([0x50,0x4b,0x03,0x04]);
    it('accepts complete RAR4 and RAR5 signatures while preserving ZIP', () => {
        expect(() => validatePackagePrefix(rar4, 'fix.rar')).not.toThrow();
        expect(() => validatePackagePrefix(rar5, 'fix.RAR')).not.toThrow();
        expect(() => validatePackagePrefix(zip, 'fix.zip')).not.toThrow();
        expect(safeFilename('fix.rar', 'fix')).toBe('fix.rar');
        expect(() => safeFilename('fix.rar', 'manifest')).toThrow();
    });
    it('rejects mismatched, truncated and HTML bodies masquerading as archives', () => {
        for (const bytes of [zip, rar4.subarray(0,6), rar5.subarray(0,7), new TextEncoder().encode('<html>error</html>')])
            expect(() => validatePackagePrefix(bytes, 'fix.rar')).toThrow();
        expect(() => validatePackagePrefix(rar4, 'fix.zip')).toThrow();
        expect(() => validatePackagePrefix(new Uint8Array([...rar5.subarray(0,7),2]), 'fix.rar')).toThrow();
    });
});

describe('Ryuu detail routing', () => {
    it('reads Ryuu details without requesting LuaTools and saves an ordinary revisioned snapshot', async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json([ryuuGame()])); vi.stubGlobal('fetch', fetcher);
        const writes: unknown[][] = [];
        await syncDetails(sqlMock((q, v) => {
            if (q.includes('select provider')) return [{ provider: 'ryuu' }];
            if (q.includes('for update')) return [{ app_id: 730, provider: 'ryuu', active: true }];
            if (q.includes('insert into fixes_entries')) writes.push(v);
            return [];
        }), 730);
        expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toContain('/files/fixes.json');
        expect(writes[0][0]).toBe(entry().id); expect(writes[0][2]).toBe(digest(JSON.stringify(entry())));
    });
    it('routes primary details only to LuaTools', async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ appid: '620', fixes: [] })); vi.stubGlobal('fetch', fetcher);
        await syncDetails(sqlMock(q => q.includes('select provider') ? [{ provider: 'luatools' }]
            : q.includes('for update') ? [{ app_id: 620, provider: 'luatools', active: true }] : []), 620);
        expect(fetcher.mock.calls[0][0]).toBe('https://lua.tools/api/denuvo/fixes?appid=620');
    });
    it('does not publish details if the catalog source changed during the fetch', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([ryuuGame()])));
        let wrote = false;
        await expect(syncDetails(sqlMock(q => {
            if (q.includes('select provider')) return [{ provider: 'ryuu' }];
            if (q.includes('for update')) return [{ provider: 'luatools', active: true }];
            wrote = true; return [];
        }), 730)).rejects.toMatchObject({ code: 'CATALOG_CHANGED' });
        expect(wrote).toBe(false);
    });
    it('deactivates removed Ryuu packages instead of retaining stale downloads', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([ryuuGame('620')])));
        const queries: string[] = [];
        await syncDetails(sqlMock(q => { queries.push(q); return q.includes('select provider') ? [{ provider: 'ryuu' }]
            : q.includes('for update') ? [{ provider: 'ryuu', active: true }] : []; }), 730);
        expect(queries.some(q => q.includes('update fixes_entries set active=false'))).toBe(true);
        expect(queries.some(q => q.includes('insert into fixes_entries'))).toBe(false);
    });
    it('omits the private source URL from client responses', async () => {
        const url = new URL('https://worker.test/api/fixes/730');
        const context = { env: {}, url, request: new Request(url), params: ['730'] } as unknown as RouteContext;
        const response = await fixesDetailRoute.handle(context, 730, sqlMock(q => q.includes('access_role_code')
            ? [{ access_role_code: 3 }] : q.includes('select app_id::text') ? [{ fresh: true, name: 'Fixture' }]
            : [{ snapshot: entry(), revision: 'a'.repeat(64) }]));
        expect(response.status).toBe(200);
        const data = await response.json() as any;
        expect(data.fixes[0].provider).toBe('ryuu'); expect(data.fixes[0]).not.toHaveProperty('sourceUrl');
    });
});

describe('Ryuu package authentication', () => {
    const env = { RYUU_AUTH_CODE: 'fixture-secret-code' } as Env;
    const sql = () => sqlMock(q => q.includes('select e.app_id,e.snapshot') ? [{ app_id: 730, snapshot: entry() }] : []);
    it('attaches the secret only to the fixed Ryuu file request without using LuaTools accounts', async () => {
        const calls: URL[] = [];
        vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
            const url = new URL(String(raw)); calls.push(url);
            expect(init?.headers ?? {}).not.toHaveProperty('Authorization');
            if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
            return new Response(new Uint8Array([80, 75, 3, 4]));
        }));
        const queries: string[] = [];
        const response = await fetchFixPackage(sqlMock(q => { queries.push(q); return q.includes('select e.app_id,e.snapshot') ? [{ app_id: 730, snapshot: entry() }] : []; }), env, entry().id, 'fix');
        await response.body?.cancel();
        expect(calls.filter(url => url.searchParams.has('auth_code'))).toHaveLength(1);
        expect(calls.find(url => url.hostname === 'generator.ryuu.lol')?.searchParams.get('auth_code')).toBe(env.RYUU_AUTH_CODE);
        expect(queries.every(q => !q.includes('fixes_provider_accounts') && !q.includes('fixes_provider_usage'))).toBe(true);
        expect(calls.every(url => url.hostname !== 'lua.tools')).toBe(true);
    });
    it('rejects missing credentials and manifest requests before network access', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sql(), {} as Env, entry().id, 'fix')).rejects.toMatchObject({ code: 'RYUU_AUTH_CONFIG' });
        await expect(fetchFixPackage(sql(), env, entry().id, 'manifest')).rejects.toMatchObject({ code: 'RYUU_SLOT' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('blocks credentials from crossing origins through redirects', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
            const url = new URL(String(raw)); calls.push(url.hostname);
            return url.hostname === 'cloudflare-dns.com' ? Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
                : new Response(null, { status: 302, headers: { location: 'https://evil.test/file?auth_code=fixture-secret-code' } });
        }));
        await expect(fetchFixPackage(sql(), env, entry().id, 'fix')).rejects.toMatchObject({ code: 'RYUU_DOWNLOAD_REDIRECT' });
        expect(calls).not.toContain('evil.test');
    });
    it('rejects tampered snapshots before using the download credential', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sqlMock(() => [{ app_id: 730, snapshot: { ...entry(), sourceUrl: 'https://generator.ryuu.lol/fixes/changed.zip' } }]), env, entry().id, 'fix'))
            .rejects.toMatchObject({ code: 'RYUU_ENTRY' });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
