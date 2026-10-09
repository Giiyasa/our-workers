import {describe,it,expect,vi,afterEach} from 'vitest';
import {chartEntries,saveChart,syncHomeFeed} from '../src/lib/home-feed';
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
 it('retains failing section while updating successful section',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:URL)=>Response.json({response:url.pathname.includes('GetMostPlayed')?{ranks:[{appid:2,rank:1}]}:{}})));
  const sql=vi.fn(async(parts:TemplateStringsArray)=>parts.join('').includes('select e.appid')?[{appid:2,rank:1}]:[]) as unknown as Sql;
  expect(await syncHomeFeed(sql,new Date('2026-10-09'))).toEqual({most_played:1,popular_new_releases:'retained_previous'});
 });
});
