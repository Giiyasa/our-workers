import { syncHomeFeed } from '../lib/home-feed';
import {json} from '../lib/http';
import {shapeGame} from '../shape';
import type {DbRoute} from '../lib/types';
export const curatedRoute:DbRoute={
 method:'GET',path:'/api/curated',token:'none',requiresDb:true,
 handle:async(_ctx,_input,sql)=>{
  const feed=await sql`select f.section,f.updated_at as feed_updated_at,g.* from home_feed f
   cross join lateral jsonb_to_recordset(f.entries) as e(appid bigint,rank integer)
   join game_lists g on g.app_id=e.appid where f.section in ('trending','top_rated','highlights')
   order by f.section,e.rank`;
  const section=(key:string)=>feed.filter(row=>row.section===key).slice(0,25).map(shapeGame);
  const trending=section('trending'),topRated=section('top_rated'),highlights=section('highlights');
  return json({ok:true,week:new Date().toISOString().slice(0,10),trending,top_rated:topRated,
   highlights,our_picks:highlights,most_played:trending,popular_new_releases:[],
   hero:highlights[0]??topRated[0]??trending[0]??null,feed_updated_at:feed[0]?.feed_updated_at??null});
 }
};
export const homeSyncRoute:DbRoute={method:'POST',path:'/api/admin/home/sync',token:'write',requiresDb:true,
 handle:async(_ctx,_input,sql)=>{
  const sections=await syncHomeFeed(sql);
  const failed='status' in sections;
  if(!failed)await caches.default.delete(new Request(`${_ctx.url.origin}/api/curated`,{method:'GET'}));
  return json({ok:!failed,sections},failed?503:200);
 }};
