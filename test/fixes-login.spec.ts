import { describe, it, expect, vi, afterEach } from 'vitest';
import { fixesAdminLoginRoute } from '../src/routes/fixes-login';
import { decryptAsset } from '../src/lib/asset-crypto';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';

afterEach(()=>vi.unstubAllGlobals());
const key='11'.repeat(32),id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input={auth_code:'fixture-code',code_verifier:'v'.repeat(64),label:'Worker account'};
const access='fixture-access-token-for-worker',refresh='fixture-refresh-token-for-worker';
const context=(env:Partial<Env>={FIXES_SESSION_KEY_HEX:key})=>({env} as RouteContext);

describe('Worker owns provider token exchange',()=>{
    it('exchanges PKCE and stores encrypted tokens without returning them to the CLI',async()=>{
        const queries:{q:string;v:unknown[]}[]=[];
        const sql=((parts:TemplateStringsArray,...v:unknown[])=>{queries.push({q:parts.join(' '),v});return Promise.resolve([]);}) as unknown as Sql;
        const fetcher=vi.fn(async(raw:string)=>new URL(raw).pathname.endsWith('/user')?Response.json({id}):Response.json({access_token:access,refresh_token:refresh,expires_in:3600}));
        vi.stubGlobal('fetch',fetcher);
        const response=await fixesAdminLoginRoute.handle(context(),input,sql);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ok:true,account_id:id});
        expect(fetcher.mock.calls[0][0]).toBe('https://db.lua.tools/auth/v1/token?grant_type=pkce');
        const saved=queries.find(q=>q.q.includes('insert into fixes_provider_accounts'))!;
        const encrypted=saved.v.find(v=>typeof v==='string'&&v.startsWith('53474131')) as string;
        expect(JSON.parse(new TextDecoder().decode(await decryptAsset(encrypted,key)))).toEqual({access_token:access,refresh_token:refresh});
        expect(saved.v).not.toContain(access);
        expect(saved.v).not.toContain(refresh);
    });
    it.each([400,401,503])('does not expose provider bodies when exchange returns HTTP %s',async status=>{
        vi.stubGlobal('fetch',vi.fn(async()=>new Response('sensitive-provider-body',{status})));
        const response=await fixesAdminLoginRoute.handle(context(),input,{} as Sql);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ok:false,code:'LOGIN_EXCHANGE_FAILED',error:'Login provider gagal. Ulangi login admin.'});
    });
    it('requires the session encryption key before exchanging a one-time code',async()=>{
        const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
        const response=await fixesAdminLoginRoute.handle(context({}),input,{} as Sql);
        expect(await response.json()).toMatchObject({code:'SESSION_CONFIG'});
        expect(fetcher).not.toHaveBeenCalled();
    });
});
