import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSteamGames, saveSteamSearchGames } from '../src/lib/steam-search';
import { gamesListRoute } from '../src/routes/games-list';
import { gamesDetailRoute } from '../src/routes/games-detail';
import { providerAccessToken } from '../src/lib/fixes-provider';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';

vi.mock('../src/lib/fuzzy', () => ({ hasLevenshtein: async () => false }));
vi.mock('../src/lib/fixes-provider', () => ({ providerAccessToken: vi.fn() }));
vi.mock('../src/lib/steam-search', async original => ({
    ...await original<typeof import('../src/lib/steam-search')>(), saveSteamSearchGames: vi.fn(),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function steam(items: unknown[], status = 200) {
    const fetcher = vi.fn(async (raw: string | URL) => {
        const url = new URL(raw);
        if (url.pathname.includes('/steam/search')) return Response.json({ results: items.map((item: any)=>({...item,appid:item.id,icon:item.tiny_image})) }, { status });
        if (url.pathname.includes('storesearch')) return Response.json({ items }, { status });
        if (url.pathname.includes('/steam/details')) return new Response(null,{status:503});
        const id = url.searchParams.get('appids')!;
        return Response.json({ [id]: { success: true, data: { name: 'Steam Game', short_description: 'Official description',
            genres: [{ id: 1, description: 'Action' }], categories: [{ id: 2, description: 'Single-player' }] } } });
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
}

describe('Steam search fallback', () => {
    it('uses the LuaTools query, validates and deduplicates AppIDs, enriches metadata, and caps results at eight', async () => {
        const fetcher = steam(Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `Game ${index}` })));
        const result = await searchSteamGames('missing & game');
        expect(result).toHaveLength(8);
        expect(result[0]).toMatchObject({ app_id: 1, genre: ['Action'], categories: ['Single-player'], description: 'Official description' });
        const url = new URL(fetcher.mock.calls[0][0]);
        expect(url.origin+url.pathname).toBe('https://lua.tools/api/steam/search');
        expect(url.searchParams.get('q')).toBe('missing & game');
        expect(String(fetcher.mock.calls[0][0])).toContain('q=missing%20%26%20game');
        expect(String(fetcher.mock.calls[0][0])).not.toContain('+');
        steam([{ id: 620, name: 'Portal' }, { id: 620, name: 'Duplicate' }, { id: -1, name: 'Bad' }, { id: 1, name: '' }]);
        expect(await searchSteamGames('portal')).toHaveLength(1);
    });
    it('distinguishes an upstream outage from an empty search and makes no import on failure', async () => {
        steam([], 429);
        await expect(searchSteamGames('missing')).rejects.toThrow();
        expect(saveSteamSearchGames).not.toHaveBeenCalled();
    });
    it('keeps basic results if optional appdetails cannot be reached', async () => {
        vi.stubGlobal('fetch', vi.fn(async (raw: string | URL) => new URL(raw).pathname.includes('storesearch')
            ? Response.json({ items: [{ id: 620, name: 'Portal' }] }) : new Response(null, { status: 503 })));
        expect(await searchSteamGames('portal')).toMatchObject([{ app_id: 620, description: null, genre: [], categories: [] }]);
    });
    it('uses the real LuaTools response format and imports its genres, header and release date', async () => {
        const fetcher=vi.fn(async(raw:string|URL)=>new URL(raw).pathname.endsWith('/search')
            ? Response.json({results:[{appid:1947910,name:'OPUS: Prism Peak',icon:'https://image.test/icon.jpg'}]})
            : Response.json({appid:1947910,name:'OPUS: Prism Peak',type:'game',genres:['Adventure','Indie'],headerImage:'https://image.test/header.jpg',releaseDate:'Apr 15, 2026'}));
        vi.stubGlobal('fetch',fetcher);
        expect(await searchSteamGames('OPUS: Prism Peak')).toMatchObject([{app_id:1947910,name:'OPUS: Prism Peak',genre:['Adventure','Indie'],image:'https://image.test/header.jpg',release_date:'2026-04-15'}]);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('appid')).toBe('1947910');
    });
    it('falls back to direct Steam only when the LuaTools search fails',async()=>{
        const fetcher=steam([{id:620,name:'Portal'}]);
        fetcher.mockImplementationOnce(async()=>new Response(null,{status:503}));
        expect(await searchSteamGames('portal')).toHaveLength(1);
        expect(new URL(fetcher.mock.calls[1][0]).hostname).toBe('store.steampowered.com');
    });
    it('returns partial LuaTools details when direct Steam is unavailable',async()=>{
        vi.stubGlobal('fetch',vi.fn(async(raw:string|URL)=>new URL(raw).hostname==='lua.tools'
            ? Response.json({appid:1947910,name:'OPUS: Prism Peak',genres:['Adventure','Indie'],releaseDate:'Apr 15, 2026'})
            : new Response(null,{status:503})));
        const response=await gamesDetailRoute.handle({} as RouteContext,{gameId:1947910},(()=>Promise.resolve([])) as unknown as Sql);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({metadata_source:'luatools',detail_partial:true,data:{name:'OPUS: Prism Peak',screenshots:[],genres:[{id:null,description:'Adventure'},{id:null,description:'Indie'}]}});
    });
    it('saves missing Steam games and returns stored database IDs with normal pagination', async () => {
        steam([{ id: 620, name: 'Portal' }]);
        vi.mocked(saveSteamSearchGames).mockResolvedValue([{ id: 321, app_id: 620, name: 'Portal', genre: ['Action'] }] as never);
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ search_source: 'steam', total: 1, total_approximate: false, data: [{ id: 321, app_id: 620 }] });
        expect(saveSteamSearchGames).toHaveBeenCalledOnce();
    });
    it('does not call Steam when a local match exists or the page is out of range', async () => {
        const fetcher = steam([]);
        await request({ local: true });await request({ existing: true, page: 99 });
        expect(fetcher).not.toHaveBeenCalled();expect(saveSteamSearchGames).not.toHaveBeenCalled();
    });
    it('also falls back for count_only and preserves genre/category filters', async () => {
        steam([{ id: 620, name: 'Portal' }]);
        vi.mocked(saveSteamSearchGames).mockResolvedValue([{ id: 321, app_id: 620, name: 'Portal', genre: ['Action'], categories: ['Single-player'] }] as never);
        expect(await (await request({ countOnly: true })).json()).toMatchObject({ total: 1, search_source: 'steam' });
        expect(await (await request({ genre: 'Racing' })).json()).toMatchObject({ total: 0, data: [] });
    });
    it('keeps the catalog response usable while marking external search incomplete on outages', async () => {
        steam([], 503);
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok:true, data:[], total_approximate:true, search_incomplete:true, search_warning:{code:'STEAM_SEARCH_UNAVAILABLE'} });
        expect(saveSteamSearchGames).not.toHaveBeenCalled();
    });
    it('does not claim a definitive zero count when external count search fails',async()=>{
        steam([],503);
        expect(await (await request({countOnly:true})).json()).toMatchObject({total:0,total_approximate:true,search_incomplete:true});
    });
    it('retries a LuaTools 401 using a metadata session without reserving download usage or caching its response',async()=>{
        const sql={} as Sql,env={} as Env;
        vi.mocked(providerAccessToken).mockResolvedValue({token:'synthetic-metadata-token',accountId:'fixture',version:'1'});
        const fetcher=vi.fn(async(raw:string|URL,init?:RequestInit)=>{
            const url=new URL(raw);
            if(url.pathname.endsWith('/search'))return init?.headers
                ? Response.json({results:[{appid:620,name:'Portal'}]}) : new Response(null,{status:401});
            return new Response(null,{status:503});
        });
        vi.stubGlobal('fetch',fetcher);
        expect(await searchSteamGames('portal',{sql,env})).toMatchObject([{app_id:620,name:'Portal'}]);
        expect(providerAccessToken).toHaveBeenCalledWith(sql,env,true,[],false);
        const authCall=fetcher.mock.calls.find(([,init])=>(init?.headers as any)?.Authorization);
        expect(String(authCall?.[0])).toContain('https://lua.tools/api/steam/search');
        expect(authCall?.[1]).toMatchObject({headers:{Authorization:'Bearer synthetic-metadata-token'},cf:{cacheEverything:false,cacheTtl:0}});
        for(const [raw,init] of fetcher.mock.calls)if(new URL(raw).hostname!=='lua.tools')expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    });
    it('returns 503 when catalog persistence fails instead of presenting an unclaimable result', async () => {
        steam([{ id: 620, name: 'Portal' }]);
        vi.mocked(saveSteamSearchGames).mockRejectedValue(new Error('Database unavailable'));
        const response = await request();
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'STEAM_CATALOG_SAVE_FAILED' });
    });
});

async function request(options: { local?: boolean; existing?: boolean; page?: number; countOnly?: boolean; genre?: string } = {}) {
    const url = new URL('https://fixture.test/api/games?search=missing');
    url.searchParams.set('page', String(options.page ?? 1));
    if (options.countOnly) url.searchParams.set('count_only', 'true');
    if (options.genre) url.searchParams.set('genre', options.genre);
    const sql = ((parts: TemplateStringsArray | string) => {
        if (typeof parts === 'string') return parts;
        const query = parts.join(' ');
        if (query.includes('as total')) return Promise.resolve([{ total: options.local || options.existing ? 1 : 0 }]);
        if (query.includes('select g.app_id')) return Promise.resolve(options.existing ? [{ app_id: 620 }] : []);
        return Promise.resolve(options.local ? [{ id: 321, app_id: 620, name: 'Portal' }] : []);
    }) as unknown as Sql;
    const context = { url, request: new Request(url) } as RouteContext;
    const prepared = await gamesListRoute.prepare!(context);
    if (prepared instanceof Response) return prepared;
    return gamesListRoute.handle(context, prepared.input, sql);
}
