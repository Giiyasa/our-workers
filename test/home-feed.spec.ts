import {describe,it,expect,vi,afterEach} from 'vitest';
import {chartEntries,saveChart,syncHomeFeed,ratedGames,rankSelections} from '../src/lib/home-feed';
import type {Sql} from '../src/lib/db';
afterEach(()=>vi.unstubAllGlobals());
describe('Home snapshots',()=>{
 it('validates, deduplicates and preserves Steam rank',()=>{
  expect(chartEntries([{appid:2,rank:2},{appid:1,rank:1},{appid:1},{appid:-1},{}])).toEqual([{appid:1,rank:1},{appid:2,rank:2}]);
  expect(()=>chartEntries(undefined)).toThrow();
 });
 it('does not overwrite last successful snapshot on empty source',async()=>{
  const sql=vi.fn() as unknown as Sql;
  await expect(saveChart(sql,'most_played',[],null)).rejects.toThrow('HOME_EMPTY');
  expect(sql).not.toHaveBeenCalled();
 });
 it('bounds candidates and stores only catalog matches',async()=>{
  const calls:unknown[][]=[];
  const sql=((parts:TemplateStringsArray,...values:unknown[])=>{calls.push(values);return Promise.resolve(calls.length===1?[{appid:'2',rank:2}]:[]);}) as unknown as Sql;
  await saveChart(sql,'most_played',Array.from({length:200},(_,i)=>({appid:i+1,rank:i+1})),null);
  expect(JSON.parse(calls[0][0] as string)).toHaveLength(100);
  expect(JSON.parse(calls[1][1] as string)).toEqual([{appid:2,rank:2}]);
 });
 it('retains snapshots when Steam metadata fails',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:URL)=>Response.json({response:url.pathname.includes('GetMostPlayed')?{ranks:[{appid:2,rank:1}]}:{}})));
  const sql=vi.fn(async()=>[]) as unknown as Sql;
  expect(await syncHomeFeed(sql,new Date('2026-10-09'))).toEqual({status:'retained_previous'});
 });
 it('excludes free games, software, unknown prices and weak reviews',()=>{
  const item={success:1,type:0,appid:2,best_purchase_option:{final_price_in_cents:'999'},reviews:{summary_filtered:{review_count:10000,percent_positive:95}}};
  expect(ratedGames([item,{...item,appid:3,is_free:true},{...item,appid:4,type:1},{...item,appid:5,best_purchase_option:{}},{...item,appid:6,reviews:{summary_filtered:{review_count:10,percent_positive:100}}}],new Map([[2,1]]))).toEqual([{appid:2,reviews:10000,positive:95,chartRank:1}]);
 });
 it('ranks quality with review confidence and limits every section',()=>{
  const games=Array.from({length:40},(_,i)=>({appid:i+1,positive:95,reviews:10000,chartRank:i+1}));
  const ranked=rankSelections(games);
  expect(ranked.trending).toHaveLength(25);expect(ranked.top_rated).toHaveLength(25);expect(ranked.highlights).toHaveLength(25);
  const result=rankSelections([{appid:1,positive:100,reviews:1000,chartRank:null},{appid:2,positive:96,reviews:250000,chartRank:null}]);
  expect(result.top_rated.map(e=>e.appid)).toEqual([2]);expect(result.highlights[0].appid).toBe(2);
 });
});
