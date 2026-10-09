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
export type RatedGame = {appid:number; positive:number; reviews:number; chartRank:number | null};
export function ratedGames(items: unknown, ranks: Map<number,number>): RatedGame[] {
 if (!Array.isArray(items)) throw new Error('HOME_INVALID_ITEMS');
 const seen=new Set<number>();
 return items.flatMap(item => {
  const summary=item?.reviews?.summary_filtered;
  const price=Number(item?.best_purchase_option?.final_price_in_cents);
  if(item?.success!==1 || item?.type!==0 || item?.is_free===true || !Number.isFinite(price) || price<=0 ||
   !Number.isSafeInteger(item.appid) || item.appid<=0 || seen.has(item.appid) ||
   !Number.isSafeInteger(summary?.review_count) || summary.review_count<1000 ||
   !Number.isFinite(summary?.percent_positive) || summary.percent_positive<80 || summary.percent_positive>100) return [];
  seen.add(item.appid);
  return [{appid:item.appid,positive:summary.percent_positive,reviews:summary.review_count,chartRank:ranks.get(item.appid)??null}];
 });
}
export function rankSelections(games: RatedGame[]) {
 // Confidence-adjusted rating prevents tiny samples outranking established games.
 const score=(g:RatedGame)=>(g.positive*g.reviews+85*5000)/(g.reviews+5000);
 const ranked=(rows:RatedGame[])=>rows.slice(0,HOME_LIMIT).map((g,i)=>({appid:g.appid,rank:i+1}));
 return {
  trending:ranked(games.filter(g=>g.chartRank!==null).sort((a,b)=>a.chartRank!-b.chartRank!)),
  top_rated:ranked(games.filter(g=>g.positive>=90 && g.reviews>=5000).sort((a,b)=>score(b)-score(a)||b.reviews-a.reviews)),
  highlights:ranked([...games].sort((a,b)=>(score(b)+Math.log10(b.reviews+1)*2)-(score(a)+Math.log10(a.reviews+1)*2)))
 };
}
export async function syncHomeFeed(sql: Sql, now = new Date(), _apiKey?: string) {
 try {
  const entries=chartEntries((await chart('GetMostPlayedGames')).ranks).slice(0,100);
  const ranks=new Map(entries.map(e=>[e.appid,e.rank]));
  // A small rotating catalog sample adds quieter classics/indies to chart candidates.
  const extra=await sql`select app_id from game_lists where image is not null and image <> ''
   order by md5(app_id::text || ${now.toISOString().slice(0,10)}) limit 25`;
  const previous=await sql`select entries from home_feed where section in ('trending','top_rated','highlights')`;
  const ids=new Set(entries.map(e=>e.appid));
  for(const row of extra) if(Number.isSafeInteger(Number(row.app_id)))ids.add(Number(row.app_id));
  for(const row of previous) if(Array.isArray(row.entries))for(const e of row.entries)if(Number.isSafeInteger(e.appid))ids.add(e.appid);
  const candidates=[...ids].filter(id=>id>0).slice(0,200);
  const games:RatedGame[]=[];
  // Eight batches maximum, serial requests, no per-game HTTP calls.
  for(let i=0;i<candidates.length;i+=25){
   const url=new URL('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/');
   url.searchParams.set('input_json',JSON.stringify({ids:candidates.slice(i,i+25).map(appid=>({appid})),
    context:{language:'english',country_code:'US'},data_request:{include_reviews:true}}));
   const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('HOME_METADATA_HTTP');
   const text=await response.text();if(text.length>2000000)throw new Error('HOME_METADATA_SIZE');
   games.push(...ratedGames(JSON.parse(text).response?.store_items,ranks));
  }
  const selections=rankSelections(games);
  const counts:Record<string,number>={};
  // Publish all sections together; failures preserve the previous complete snapshot.
  await sql.begin(async tx=>{
   for(const [section,selected] of Object.entries(selections)){
    if(!selected.length){
     await tx`insert into home_feed(section,entries,updated_at) values(${section},'[]'::jsonb,now())
      on conflict(section) do update set entries=excluded.entries,updated_at=excluded.updated_at`;
     counts[section]=0;continue;
    }
    counts[section]=await saveChart(tx as unknown as Sql,section,selected,null);
   }
  });
  return counts;
 } catch {console.warn('home_quality_sync_failed');return {status:'retained_previous'};}
}
