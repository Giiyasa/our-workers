import type { Sql } from './db';
import { fetchSteamDetail, mapWithLimit, pickImageUrl, toSteamAppId } from './steam';

export class SteamSearchFailure extends Error {}
interface SearchGame {
    app_id: number;
    name: string;
    image: string;
    description: string | null;
    genre: string[];
    categories: string[];
}

/** Same Store search and eight-result limit used by LuaTools. No provider credentials. */
export async function searchSteamGames(query: string): Promise<SearchGame[]> {
    const url = new URL('https://store.steampowered.com/api/storesearch/');
    url.searchParams.set('term', query);
    url.searchParams.set('l', 'english');
    url.searchParams.set('cc', 'US');
    let payload: unknown;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error',
            cf: { cacheEverything: true, cacheTtl: 300 } });
        if (!response.ok) throw new SteamSearchFailure('STEAM_SEARCH_HTTP');
        const text = await response.text();
        if (text.length > 1_000_000) throw new SteamSearchFailure('STEAM_SEARCH_SIZE');
        payload = JSON.parse(text);
    } catch { throw new SteamSearchFailure('STEAM_SEARCH_UNAVAILABLE'); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as {items?: unknown}).items)) {
        throw new SteamSearchFailure('STEAM_SEARCH_FORMAT');
    }
    const seen = new Set<number>();
    const games: SearchGame[] = [];
    for (const item of (payload as {items: unknown[]}).items.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>, appId = toSteamAppId(row.id);
        if (!appId || seen.has(appId) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 1000) continue;
        seen.add(appId);
        games.push({ app_id: appId, name: row.name.trim(), image: pickImageUrl(row.tiny_image) ??
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_sm_120.jpg`,
            description: null, genre: [], categories: [] });
    }
    // Enrich catalog filters without blocking basic search results when appdetails fails.
    return mapWithLimit(games, 3, async game => {
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
        await tx`insert into game_lists(app_id,name,image,description,genre,categories,publishers)
 select s.app_id,s.name,s.image,s.description,s.genre,s.categories,array[]::text[]
 from jsonb_to_recordset(${payload}::text::jsonb) as s(app_id bigint,name text,image text,description text,genre text[],categories text[])
 where not exists(select 1 from game_lists g where g.app_id=s.app_id)
 on conflict do nothing`;
        return tx`select g.* from jsonb_to_recordset(${payload}::text::jsonb) as s(app_id bigint,rank integer)
 join lateral (select * from game_lists where app_id=s.app_id order by id limit 1) g on true order by s.rank`;
    });
}
