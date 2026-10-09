import type { Sql } from './db';
export const HOME_LIMIT = 25;
type Entry = { appid: number; rank: number };
export function chartEntries(value: unknown): Entry[] {
 if (!Array.isArray(value) || value.length > 10000) throw new Error('HOME_INVALID_CHART');
 const seen = new Set<number>();
 return value.flatMap((row, index) => {
  if (!row || !Number.isSafeInteger(row.appid) || row.appid <= 0 || seen.has(row.appid)) return [];
  seen.add(row.appid);
  return [{appid: row.appid, rank: Number.isSafeInteger(row.rank) && row.rank > 0 ? row.rank : index + 1}];
 }).sort((a,b) => a.rank-b.rank);
}
async function chart(method: string, params: Record<string, string> = {}) {
 const url = new URL(`https://api.steampowered.com/ISteamChartsService/${method}/v1/`);
 for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
 const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
 if (!response.ok) throw new Error('HOME_STEAM_HTTP');
 const text = await response.text();
 if (text.length > 2000000) throw new Error('HOME_STEAM_SIZE');
 return JSON.parse(text).response;
}
export async function saveChart(sql: Sql, section: string, entries: Entry[], period: string | null) {
 if (!entries.length) throw new Error('HOME_EMPTY_CHART');
 // Send bounded candidates as TEXT: postgres.js must not double-encode JSONB.
 const rows = await sql`select e.appid, e.rank from jsonb_to_recordset(${JSON.stringify(entries.slice(0,100))}::text::jsonb) as e(appid bigint, rank integer)
 where exists(select 1 from game_lists g where g.app_id=e.appid and g.image is not null and g.image <> '')
 order by e.rank limit 25`;
 if (!rows.length) throw new Error('HOME_NO_CATALOG_MATCH');
 const payload = JSON.stringify(rows.map(row => ({appid:Number(row.appid),rank:Number(row.rank)})));
 await sql`insert into home_feed(section,entries,source_period,updated_at) values(${section},${payload}::text::jsonb,${period},now())
 on conflict(section) do update set entries=excluded.entries,source_period=excluded.source_period,updated_at=excluded.updated_at`;
 return rows.length;
}
export async function syncHomeFeed(sql: Sql, now = new Date(), apiKey?: string) {
 const result: Record<string, string | number> = {};
 for (const section of ['most_played','popular_new_releases']) {
  try {
   let entries: Entry[], period: string | null = null;
   if (section === 'most_played') entries = chartEntries((await chart('GetMostPlayedGames')).ranks);
   else {
    const month = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1));
    period = month.toISOString().slice(0,7);
    const response = await chart('GetMonthTopAppReleases', {rtime_month:String(month.getTime()/1000),include_dlc:'false',top_results_limit:'25', ...(apiKey ? {key:apiKey} : {})});
    entries = chartEntries(response.top_combined_app_and_dlc_releases);
   }
   result[section] = await saveChart(sql,section,entries,period);
  } catch { result[section] = 'retained_previous'; console.warn('home_feed_sync_failed', {section}); }
 }
 return result;
}
