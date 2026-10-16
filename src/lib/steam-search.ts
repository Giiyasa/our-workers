import type { Sql } from './db';
import { fetchSteamDetail, mapWithLimit, pickImageUrl, toSteamAppId } from './steam';
import { fetchLuaToolsSteamDetail } from './luatools-steam';
import { providerAccessToken } from './fixes-provider';

export class SteamSearchFailure extends Error {
    constructor(message: string, public upstreamStatus?: number) { super(message); }
}
interface SearchGame {
    app_id: number;
    name: string;
    image: string;
    description: string | null;
    genre: string[];
    categories: string[];
    release_date?: string | null;
}

async function searchItems(query: string, proxy: boolean, token?: string): Promise<unknown[]> {
    const url = new URL(proxy ? 'https://lua.tools/api/steam/search' : 'https://store.steampowered.com/api/storesearch/');
    // LuaTools returns 401 for '+' spaces, while the same query with '%20' works.
    if (proxy) url.search = `?q=${encodeURIComponent(query)}`;
    else url.searchParams.set('term', query);
    if (!proxy) { url.searchParams.set('l', 'english'); url.searchParams.set('cc', 'US'); }
    let payload: unknown;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error',
            headers: token && proxy ? { Authorization: `Bearer ${token}` } : undefined,
            cf: { cacheEverything: !token, cacheTtl: token ? 0 : 300 } });
        if (!response.ok) {
            console.warn('steam_search_provider_failed', { provider: proxy ? 'luatools' : 'steam', status: response.status });
            throw new SteamSearchFailure('STEAM_SEARCH_HTTP', response.status);
        }
        const text = await response.text();
        if (text.length > 1_000_000) throw new SteamSearchFailure('STEAM_SEARCH_SIZE');
        payload = JSON.parse(text);
    } catch (error) {
        if (error instanceof SteamSearchFailure) throw error;
        console.warn('steam_search_request_failed', { provider: proxy ? 'luatools' : 'steam', reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_or_format' });
        throw new SteamSearchFailure('STEAM_SEARCH_UNAVAILABLE');
    }
    const items = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[proxy ? 'results' : 'items'] : null;
    if (!Array.isArray(items)) {
        throw new SteamSearchFailure('STEAM_SEARCH_FORMAT');
    }
    return items;
}

/** LuaTools public Steam proxy first; direct Steam is a fallback for proxy outages. */
export async function searchSteamGames(query: string, context?: { sql: Sql; env: Env }): Promise<SearchGame[]> {
    let items: unknown[], proxy = true;
    try { items = await searchItems(query, true); }
    catch (error) {
        console.warn('steam_search_proxy_unavailable', { provider: 'luatools' });
        let recovered: unknown[] | undefined;
        if (context && error instanceof SteamSearchFailure && [401,403].includes(error.upstreamStatus ?? 0)) {
            try {
                // Search is metadata, not a download: never reserve user/provider download usage.
                const credential = await providerAccessToken(context.sql, context.env, true, [], false);
                recovered = await searchItems(query, true, credential.token);
            } catch (authError) {
                const code = authError && typeof authError === 'object' && 'code' in authError ? String(authError.code) : '';
                console.warn('steam_search_authenticated_failed', { status: authError instanceof SteamSearchFailure ? authError.upstreamStatus : undefined,
                    reason: authError instanceof SteamSearchFailure ? authError.message : /^[A-Z_]{1,60}$/.test(code) ? code : 'SESSION_UNAVAILABLE' });
            }
        }
        if (recovered !== undefined) items = recovered;
        else { proxy = false; items = await searchItems(query, false); }
    }
    const seen = new Set<number>();
    const games: SearchGame[] = [];
    for (const item of items.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>, appId = toSteamAppId(proxy ? row.appid : row.id);
        if (!appId || seen.has(appId) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 1000) continue;
        seen.add(appId);
        games.push({ app_id: appId, name: row.name.trim(), image: pickImageUrl(proxy ? row.icon : row.tiny_image) ??
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg`,
            description: null, genre: [], categories: [] });
    }
    // Enrich catalog filters without blocking basic search results when appdetails fails.
    return mapWithLimit(games, 3, async game => {
        const metadata = await fetchLuaToolsSteamDetail(game.app_id);
        if (metadata) return { ...game, name: metadata.name, image: metadata.image ?? game.image,
            genre: metadata.genres, release_date: metadata.releaseDate };
        const result = await fetchSteamDetail(game.app_id);
        return result.ok ? { ...game, description: result.detail.short_description,
            genre: result.detail.genres.map(item => item.description),
            categories: result.detail.categories.map(item => item.description) } : game;
    });
}

/** Insert only missing AppIDs; preserve existing metadata, unavailable flags, and assets. */
export async function saveSteamSearchGames(sql: Sql, games: SearchGame[]) {
    if (!games.length) return [];
    const payload = JSON.stringify(games.map((game, rank) => ({ ...game, rank })));
    return sql.begin(async tx => {
        // Serialize these small imports even on schemas without a unique AppID constraint.
        await tx`select pg_advisory_xact_lock(731192061)`;
        await tx`insert into game_lists(app_id,name,image,description,genre,categories,publishers,release_date)
 select s.app_id,s.name,s.image,s.description,s.genre,s.categories,array[]::text[],s.release_date
 from jsonb_to_recordset(${payload}::text::jsonb) as s(app_id bigint,name text,image text,description text,genre text[],categories text[],release_date date)
 where not exists(select 1 from game_lists g where g.app_id=s.app_id)
 on conflict do nothing`;
        return tx`select g.* from jsonb_to_recordset(${payload}::text::jsonb) as s(app_id bigint,rank integer)
 join lateral (select * from game_lists where app_id=s.app_id order by id limit 1) g on true order by s.rank`;
    });
}
