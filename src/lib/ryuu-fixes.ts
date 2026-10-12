import { FIXES_CONFIG } from '../fixes-config.mjs';
import { digest, FixesFailure, jsonFetch, safeFilename, type FixEntry, type FixGame, type FixTag } from './fixes-provider';

export interface RyuuGame extends FixGame {
    fixes: FixEntry[];
}

// Only public catalog paths are stored. Authentication is attached at download time.
export function ryuuFixUrl(raw: unknown): URL {
    let url: URL;
    try { url = new URL(typeof raw === 'string' ? raw : ''); }
    catch { throw new FixesFailure('RYUU_DOWNLOAD_URL'); }
    let path: string;
    try { path = decodeURIComponent(url.pathname); }
    catch { throw new FixesFailure('RYUU_DOWNLOAD_URL'); }
    if (url.origin !== FIXES_CONFIG.ryuu || url.username || url.password || url.search || url.hash ||
        !/^\/fixes\/[^/\\\x00-\x1f\x7f]+\.(zip|rar)$/i.test(path))
        throw new FixesFailure('RYUU_DOWNLOAD_URL');
    return url;
}

export function parseRyuuCatalog(raw: unknown): RyuuGame[] {
    if (!Array.isArray(raw) || !raw.length || raw.length > 20000) throw new FixesFailure('RYUU_CATALOG_FORMAT');
    const appIds = new Set<string>();
    return raw.map((game) => {
        if (!game || !/^\d+$/.test(String(game.appid)) || !Number.isSafeInteger(Number(game.appid)) ||
            Number(game.appid) <= 0 || typeof game.name !== 'string' ||
            !Array.isArray(game.fixes) || game.fixes.length > 1000)
            throw new FixesFailure('RYUU_CATALOG_FORMAT');
        const appid = String(Number(game.appid));
        if (appIds.has(appid)) throw new FixesFailure('RYUU_CATALOG_FORMAT');
        appIds.add(appid);
        const seen = new Set<string>();
        const fixes: FixEntry[] = [];
        for (const item of game.fixes) {
            if (!item || typeof item.filename !== 'string' || typeof item.href !== 'string' ||
                (item.size != null && (typeof item.size !== 'string' || item.size.length > 100)) ||
                !Array.isArray(item.badges) || item.badges.length > 100 ||
                item.badges.some((badge: unknown) => typeof badge !== 'string' || badge.length > 100))
                throw new FixesFailure('RYUU_CATALOG_FORMAT');
            if (!/\.(zip|rar)$/i.test(item.filename)) continue;
            const filename = safeFilename(item.filename, 'fix');
            const url = ryuuFixUrl(item.href);
            if (decodeURIComponent(url.pathname).slice('/fixes/'.length) !== filename)
                throw new FixesFailure('RYUU_CATALOG_FORMAT');
            const id = `ryuu:${appid}:${digest(url.pathname)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const tags: FixTag[] = [...new Set<string>(item.badges)].map(name => ({
                id: `ryuu:${name.toLowerCase()}`, name, slug: name.toLowerCase().replace(/\s+/g, '-'), color: null,
            }));
            fixes.push({ id, title: filename, description: item.size ? `Ukuran: ${item.size}` : null, tags, hasManifest: false, hasFix: true,
                manifestFilename: null, fixFilename: filename, createdAt: null, provider: 'ryuu', sourceUrl: url.toString() });
        }
        const tags = [...new Map(fixes.flatMap(f => f.tags).map(tag => [tag.id, tag])).values()];
        return { appid, name: game.name.trim() || `Game ${appid}`, header_image: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
            fixCount: fixes.length, tags, provider: 'ryuu' as const, fixes };
    }).filter(game => game.fixes.length > 0);
}

export async function fetchRyuuCatalog(): Promise<RyuuGame[]> {
    return parseRyuuCatalog(await jsonFetch(`${FIXES_CONFIG.ryuu}/files/fixes.json`));
}
