import { pickImageUrl, toSteamAppId } from './steam';

export interface LuaToolsSteamDetail {
    appId: number;
    name: string;
    type: string | null;
    genres: string[];
    image: string | null;
    releaseDate: string | null;
}

/** Public Steam metadata proxy; never attach Lua/Fixes account credentials. */
export async function fetchLuaToolsSteamDetail(appId: number): Promise<LuaToolsSteamDetail | null> {
    if (!toSteamAppId(appId)) return null;
    try {
        const response = await fetch(`https://lua.tools/api/steam/details?appid=${appId}`, {
            signal: AbortSignal.timeout(8000), redirect: 'error', cf: { cacheEverything: true, cacheTtl: 300 },
        });
        if (!response.ok) return null;
        const text = await response.text();
        if (text.length > 1_000_000) return null;
        const data = JSON.parse(text);
        if (!data || toSteamAppId(data.appid) !== appId || typeof data.name !== 'string' || !data.name.trim()) return null;
        // Steam uses an English date label here, not an ISO timestamp. Leave unknown dates empty.
        const timestamp = typeof data.releaseDate === 'string' && /^[A-Za-z]{3} \d{1,2}, \d{4}$/.test(data.releaseDate)
            ? Date.parse(`${data.releaseDate} UTC`) : NaN;
        return { appId, name: data.name.trim(), type: typeof data.type === 'string' ? data.type : null,
            genres: Array.isArray(data.genres) ? data.genres.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0) : [],
            image: pickImageUrl(data.headerImage), releaseDate: Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null };
    } catch { return null; }
}
