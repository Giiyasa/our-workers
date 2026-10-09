import { describe, it, expect, vi, afterEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import worker from "../src/index";
import { syncListings, allowedDownloadUrl, isPublicDownloadAddress, digest, fetchFixPackage, providerAccessToken, saveProviderSession, refreshProviderSession, validateDownloadHosts, validateFix } from '../src/lib/fixes-provider';
import { packageObjectKey, storePackage } from '../src/lib/fixes-storage';
import { fixesDetailRoute, fixesAdminSyncRoute, fixesListRoute, fixesPrepareRoute, fixesDownloadRoute } from '../src/routes/fixes';
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
    it('rejects HTTP, local, credential-bearing and alternate-port hosts', () => {
        for (const url of [
            'http://packages.test/a',
            'https://localhost/a',
            'https://user:pass@packages.test/a',
            'https://packages.test:8443/a',
            'https://127.0.0.1/a',
        ])
            expect(() => allowedDownloadUrl(url)).toThrow();
        expect(allowedDownloadUrl('https://packages.test/a?signature=fixture').hostname).toBe('packages.test');
    });
    it('sends bearer only to LuaTools and stops unsafe redirects', async () => {
        const row = await sessionRow();
        const fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
            const host = new URL(String(raw)).hostname;
            if (host === 'lua.tools') return Response.json({url:'https://packages.test/file'});
            if (host === 'cloudflare-dns.com') return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
            return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});
        });
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchFixPackage(sqlMock(() => [row]), env, 'fixture', 'fix')).rejects.toMatchObject({ code: 'DOWNLOAD_HOST' });
        const provider = fetcher.mock.calls.find(c => new URL(String(c[0])).hostname === 'lua.tools')!;
        expect((provider[1]?.headers as Record<string,string>).Authorization).toBe('Bearer fixture-provider-token');
        for(const call of fetcher.mock.calls.filter(c => new URL(String(c[0])).hostname !== 'lua.tools'))
            expect((call[1]?.headers as Record<string,string>|undefined)?.Authorization).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(4);
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
    it('downloads a new provider host without any manual host settings', async () => {
        const row=await sessionRow();const queries:string[]=[];
        const fetcher=vi.fn(async (raw:string) => {
            const host=new URL(String(raw)).hostname;
            if(host==='lua.tools')return Response.json({url:'https://new-cdn.test/file'});
            if(host==='cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
            return new Response(new Uint8Array([0x50,0x4b,3,4]));
        });vi.stubGlobal('fetch',fetcher);
        const response=await fetchFixPackage(sqlMock(q=>{queries.push(q);return [row];}),env,'fixture','fix');
        expect(response.ok).toBe(true);await response.body?.cancel();
        expect(queries.some(q=>q.includes('select download_hosts'))).toBe(false);
        expect(queries.some(q=>q.includes('insert into fixes_provider_config'))).toBe(true);
        expect(queries.filter(q=>q.includes('insert into fixes_provider_usage'))).toHaveLength(1);
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
    it('automatically refreshes an expired account before reserving exactly one download', async () => {
        const row = await sessionRow(); let refreshed = false;
        const queries: string[] = [];
        const fetcher = vi.fn().mockResolvedValue(Response.json({access_token:'renewed-token',refresh_token:'renewed-refresh',expires_in:3600}));
        vi.stubGlobal('fetch', fetcher);
        const sql = sqlMock(q => {
            queries.push(q);
            if(q.includes('select a.account_id') && q.includes('limit 4')) return [{account_id:row.account_id}];
            if(q.includes('select a.account_id')) return refreshed ? [row] : [];
            if(q.includes('set session_encrypted=')) { refreshed=true; return []; }
            if(q.includes('select encode(session_encrypted')) return [row];
            if(q.includes('insert into fixes_provider_usage')) return [{download_count:1}];
            return [];
        });
        expect((await providerAccessToken(sql,env)).accountId).toBe(row.account_id);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toContain('grant_type=refresh_token');
        expect(queries.filter(q=>q.includes('insert into fixes_provider_usage'))).toHaveLength(1);
        expect(queries.find(q=>q.includes('limit 4'))).toContain('blocked_until');
        expect(queries.find(q=>q.includes('limit 4'))).toContain('download_count');
        expect(queries.find(q=>q.includes('select encode(session_encrypted'))).toContain('skip locked');
        expect(queries.every(q=>!q.includes('download_count=0') && !q.includes('blocked_until=null'))).toBe(true);
    });
    it('skips automatic rotation when another job already refreshed or locked the account', async () => {
        const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
        await refreshProviderSession(sqlMock(()=>[]),env,token,true);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('temporary refresh HTTP failure does not invalidate the account', async () => {
        const row=await sessionRow(); const queries:string[]=[];
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:503})));
        await expect(refreshProviderSession(sqlMock(q=>{queries.push(q);return [row];}),env,token,true)).rejects.toMatchObject({code:'PROVIDER_HTTP'});
        expect(queries.every(q=>!q.includes("last_error_code='REFRESH_REJECTED'"))).toBe(true);
    });
    it('host settings reject IPs, URLs, wildcards and localhost', () => {
        for (const h of ['127.0.0.1', 'https://packages.test', '*.packages.test', 'localhost', 'a.localhost'])
            expect(() => validateDownloadHosts([h])).toThrow();
        expect(validateDownloadHosts(['Packages.test', 'packages.test'])).toEqual(['packages.test']);
    });
});

describe('automatic download host checks',()=>{
 it('accepts a public CDN redirect without another provider request',async()=>{
  const row=await sessionRow();let providerRequests=0;const recorded:unknown[][]=[];
  vi.stubGlobal('fetch',vi.fn(async(raw:string,init?:RequestInit)=>{
   const url=new URL(String(raw));recorded.push([url,init]);
   if(url.hostname==='lua.tools'){providerRequests++;return Response.json({url:'https://first-cdn.test/file?secret=signed'});}
   if(url.hostname==='cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
   if(url.hostname==='first-cdn.test')return new Response(null,{status:302,headers:{location:'https://second-cdn.test/file'}});
   return new Response(new Uint8Array([1,2,3]));
  }));
  const res=await fetchFixPackage(sqlMock(()=>[row]),env,'fixture','manifest');expect(res.ok).toBe(true);await res.body?.cancel();expect(providerRequests).toBe(1);
  for(const [url,init] of recorded){if((url as URL).hostname!=='lua.tools')expect((init as RequestInit)?.headers ?? {}).not.toHaveProperty('Authorization');
   if((url as URL).hostname==='cloudflare-dns.com')expect((url as URL).search).not.toContain('signed');}
 });
 it('blocks domains resolving to private addresses before the file request',async()=>{
  const row=await sessionRow();const requests:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(raw:string)=>{const host=new URL(String(raw)).hostname;requests.push(host);
   if(host==='lua.tools')return Response.json({url:'https://private-cdn.test/file'});
   return Response.json({Status:0,Answer:[{type:1,data:'10.0.0.1'}]});}));
  await expect(fetchFixPackage(sqlMock(()=>[row]),env,'fixture','fix')).rejects.toMatchObject({code:'DOWNLOAD_HOST'});
  expect(requests).not.toContain('private-cdn.test');
 });
 it('fails closed on unresolved or failed DNS',async()=>{
  for(const answer of [{Status:3},{Status:0,Answer:[]},{Status:0,TC:true}]){
   const row=await sessionRow();vi.stubGlobal('fetch',vi.fn(async(raw:string)=>new URL(String(raw)).hostname==='lua.tools'?Response.json({url:'https://cdn.test/file'}):Response.json(answer)));
   await expect(fetchFixPackage(sqlMock(()=>[row]),env,'fixture','fix')).rejects.toMatchObject({code:answer.Status===0&&!answer.TC?'DOWNLOAD_HOST':'DOWNLOAD_DNS'});
  }
 });
 it('rejects nonpublic IPv4 and IPv6 address ranges',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:a00:1::'])expect(isPublicDownloadAddress(address),address).toBe(false);
  for(const address of ['93.184.216.34','1.1.1.1','192.0.78.24','2606:4700::1111','2001:4860:4860::8888'])expect(isPublicDownloadAddress(address),address).toBe(true);
 });
});

describe('Fixes catalog array binding',()=>{
 it.each([
  ['/api/fixes','{}',true],
  ['/api/fixes?installed=','{}',false],
  ['/api/fixes?installed=620,730','{620,730}',false],
 ])('binds installed IDs as explicit PostgreSQL array text for %s',async(path,arrayText,allGames)=>{
  let bound:unknown[]=[];
  const sql=sqlMock((query,values)=>{
   if(query.includes('access_role_code'))return [{access_role_code:3}];
   if(query.includes('app_id=any(')){bound=values;return [];}
   return [];
  });
  const response=await fixesListRoute.handle(context(path),undefined,sql);
  expect(response.status).toBe(200);
  expect(bound).toContain(arrayText);expect(bound).toContain(allGames);
  expect(bound.some(Array.isArray)).toBe(false);
 });
});

describe('catalog bulk sync',()=>{
 it('syncs hundreds of games using bounded batches instead of per-game writes',async()=>{
  const games=Array.from({length:500},(_,i)=>({appid:String(i+1),name:`Game ${i+1}`,tags:[],fixCount:1}));
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games})));
  const calls:{query:string;values:unknown[]}[]=[];
  const count=await syncListings(sqlMock((query,values)=>{calls.push({query,values});return [];}));
  expect(count).toBe(500);expect(calls.length).toBeGreaterThan(3);expect(calls.length).toBeLessThan(12);
  expect(calls[0].query).toContain('pg_advisory_xact_lock');
  expect(calls[1].query).toContain('set active=false');
  const batches=calls.slice(2);
  expect(batches.every(c=>c.query.includes('jsonb_to_recordset')&&c.query.includes('::text::jsonb')&&new TextEncoder().encode(c.values[0] as string).byteLength<=16*1024)).toBe(true);
  expect(batches.flatMap(c=>JSON.parse(c.values[0] as string))).toHaveLength(500);
 });
 it('does not change existing catalog when upstream snapshot is empty or duplicated',async()=>{
  const game={appid:'620',name:'Fixture',tags:[],fixCount:1};
  for(const games of [[],[game,game]]){
   let writes=0;vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games})));
   await expect(syncListings(sqlMock(()=>{writes++;return [];}))).rejects.toMatchObject({code:'CATALOG_FORMAT'});
   expect(writes).toBe(0);
  }
 });
});

describe('admin sync failure diagnostics',()=>{
 it('reports provider status without exposing tokens or response bodies',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('secret-upstream-body',{status:403})));
  const response=await fixesAdminSyncRoute.handle(context('/api/admin/fixes/sync'),null,sqlMock(()=>[]));
  expect(response.status).toBe(503);const data=await response.json() as any;
  expect(data.code).toBe('PROVIDER_AUTH');expect(data.upstream_status).toBe(403);
  expect(JSON.stringify(data)).not.toContain('secret-upstream-body');
 });
 it('reports SQLSTATE without including database error details',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games:[{appid:'620',name:'Fixture',tags:[],fixCount:1}]})));
  const error=Object.assign(new Error('postgres://secret-user:secret-password@db/secret'),{code:'42P01'});
  const response=await fixesAdminSyncRoute.handle(context('/api/admin/fixes/sync'),null,sqlMock(()=>{throw error;}));
  expect(response.status).toBe(503);const data=await response.json() as any;
  expect(data.code).toBe('SYNC_DB_FAILED');expect(data.db_code).toBe('42P01');
  expect(JSON.stringify(data)).not.toContain('secret');
 });
});

describe('sync runtime error classification',()=>{
 it('preserves Postgres transport error codes and sync stage',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games:[{appid:'620',name:'Fixture',tags:[],fixCount:1}]})));
  const error=Object.assign(new Error('sensitive-connection-string'),{code:'CONNECTION_CLOSED'});
  const response=await fixesAdminSyncRoute.handle(context('/api/admin/fixes/sync'),null,sqlMock(()=>{throw error;}));
  const data=await response.json() as any;expect(data.code).toBe('SYNC_DB_FAILED');expect(data.db_code).toBe('CONNECTION_CLOSED');expect(data.stage).toBe('lock_catalog');expect(JSON.stringify(data)).not.toContain('sensitive');
 });
 it('classifies aborted provider body without cleanup masking the cause',async()=>{
  const stream=new ReadableStream({start(controller){controller.error(new Error('sensitive-provider-message'));}});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(stream)));
  const response=await fixesAdminSyncRoute.handle(context('/api/admin/fixes/sync'),null,sqlMock(()=>[]));
  const data=await response.json() as any;expect(data.code).toBe('PROVIDER_BODY_ERROR');expect(data.stage).toBe('fetch_catalog');expect(JSON.stringify(data)).not.toContain('sensitive');
 });
});

it('sizes catalog batches by UTF-8 bytes and rejects oversized rows before DB changes',async()=>{
 const games=Array.from({length:40},(_,i)=>({appid:String(i+1),name:'\u65e5'.repeat(300),tags:[],fixCount:1}));
 const values:unknown[]=[];vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games})));
 await syncListings(sqlMock((q,v)=>{if(q.includes('jsonb_to_recordset'))values.push(v[0]);return [];}));
 expect(values.length).toBeGreaterThan(1);expect(values.every(v=>new TextEncoder().encode(v as string).byteLength<=16*1024)).toBe(true);
 let writes=0;vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({games:[{...games[0],name:'x'.repeat(17000)}]})));
 await expect(syncListings(sqlMock(()=>{writes++;return [];}))).rejects.toMatchObject({code:'CATALOG_ROW_TOO_LARGE'});expect(writes).toBe(0);
});

describe('role 4 library-only Fixes',()=>{
 it('binds account ownership to both catalog and category queries',async()=>{
  const calls:{query:string;values:unknown[]}[]=[];
  const response=await fixesListRoute.handle(context('/api/fixes'),undefined,sqlMock((query,values)=>{calls.push({query,values});return query.includes('access_role_code')?[{access_role_code:4}]:[];}));
  expect(response.status).toBe(200);
  for(const query of calls.filter(c=>c.query.includes('from fixes_catalog'))){
   expect(query.query).toContain('owned.app_id_buy=c.app_id');expect(query.values).toContain(false);expect(query.values).toContain('12');
  }
 });
 it('rejects direct detail access outside library before provider requests',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const calls:string[]=[];
  const response=await fixesDetailRoute.handle(context('/api/fixes/730'),730,sqlMock(q=>{calls.push(q);return q.includes('access_role_code')?[{access_role_code:4}]:[];}));
  expect(response.status).toBe(403);expect((await response.json() as any).code).toBe('FIXES_NOT_OWNED');
  expect(calls.some(q=>q.includes('fixes_catalog'))).toBe(false);expect(fetcher).not.toHaveBeenCalled();
 });
 it.each([2,3])('keeps the full catalog available for role %s',async(role)=>{
  let queryValues:unknown[]=[];
  const response=await fixesListRoute.handle(context('/api/fixes'),undefined,sqlMock((q,v)=>{if(q.includes('access_role_code'))return [{access_role_code:role}];if(q.includes('app_id=any('))queryValues=v;return [];}));
  expect(response.status).toBe(200);expect(queryValues).toContain(true);
 });
});
