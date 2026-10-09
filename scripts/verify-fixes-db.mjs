import {types as postgresTypes} from '../node_modules/postgres/src/types.js';
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db=new PGlite();
const revision="a".repeat(64),old="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",newToken="bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const source=await readFile(new URL("../src/lib/fixes-jobs.ts",import.meta.url),"utf8");
const queries=[...source.matchAll(/(?:sql|tx)\s*`([\s\S]*?)`/g)].map(m=>m[1]);
function template(raw,variables){let args=[];const sql=raw.replace(/\$\{([^}]+)\}/g,(_,name)=>{if(!(name in variables))throw new Error(`Missing fixture binding ${name}`);args.push(variables[name]);return `$${args.length}`;});return db.query(sql,args);}
const start=queries.find(q=>q.includes("insert into fixes_package_jobs"));
const acquire=queries.find(q=>q.includes("work_started_at=now()")||q.includes("work_started_at = now()"));
const publish=queries.find(q=>q.includes("status='ready'")||q.includes("status = 'ready'"));
assert.ok(start&&acquire&&publish,"Read actual job SQL from implementation");
const variables=(token)=>({fixId:"fixture",revision,slot:"fix",appId:620,filename:"fix.zip",token,
 "message.fixId":"fixture","message.revision":revision,"message.slot":"fix","message.requestToken":old,
 key:`fixes/fixture/${token}.bin`,"result.sha256":"b".repeat(64),"result.size":42});
try{
 await db.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
 const patch=await readFile(new URL("../supabase/FIXES_PATCH.sql",import.meta.url),"utf8");
 await db.exec(patch);await db.exec(patch); // additive/idempotent on this fixture schema
 const multiPatch=await readFile(new URL('../supabase/FIXES_MULTIACCOUNT_PATCH.sql',import.meta.url),'utf8');
 await db.exec(multiPatch);await db.exec(multiPatch);
 const rls=await db.query("select relname,relrowsecurity from pg_class where relname like 'fixes_%' and relkind='r'");assert.equal(rls.rows.length,8);assert.ok(rls.rows.every(r=>r.relrowsecurity));
 const privileges=await db.query("select has_table_privilege('anon','fixes_provider_session','SELECT') as anon,has_table_privilege('authenticated','fixes_provider_session','SELECT') as authenticated");assert.deepEqual(privileges.rows[0],{anon:false,authenticated:false});
 await db.query("insert into fixes_catalog(app_id,name)values($1,$2)",[620,"Fixture"]);
 await db.query("insert into fixes_entries(fix_id,app_id,revision,snapshot)values($1,$2,$3,$4)",["fixture",620,revision,{id:"fixture"}]);
 assert.equal((await template(start,variables(old))).rows.length,1,"first requester owns job");
 assert.equal((await template(start,variables(newToken))).rows.length,0,"concurrent request does not acquire live job");
 assert.equal((await template(acquire,variables(newToken))).rows.length,1,"consumer acquires work");
 assert.equal((await template(acquire,variables(old))).rows.length,0,"second consumer cannot acquire live work");
 await db.exec("update fixes_package_jobs set lease_expires_at=now()-interval '1 second'");
 assert.equal((await template(publish,variables(newToken))).rows.length,0,"expired consumer cannot publish");
 assert.equal((await template(start,variables(newToken))).rows.length,1,"expired job can be retried");
 const refreshed=variables(old);refreshed["message.requestToken"]=newToken;
 assert.equal((await template(acquire,refreshed)).rows.length,1,"replacement consumer acquires new request");
 assert.equal((await template(publish,variables(newToken))).rows.length,0,"stale lease cannot publish after replacement");
 assert.equal((await template(publish,refreshed)).affectedRows,1,"current lease publishes ready package");
 const job=await db.query("select status,r2_object_key,size_bytes from fixes_package_jobs");assert.equal(job.rows[0].status,"ready");assert.equal(Number(job.rows[0].size_bytes),42);
 const provider=await readFile(new URL('../src/lib/fixes-provider.ts',import.meta.url),'utf8');
 const providerQueries=[...provider.matchAll(/(?:sql|tx)\s*`([\s\S]*?)`/g)].map(m=>m[1]);
 const pick=providerQueries.find(q=>q.includes('select a.account_id::text'));
 const reserve=providerQueries.find(q=>q.includes('insert into fixes_provider_usage'));
 assert.ok(pick&&reserve);
 const first='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',second='bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const limits={'FIXES_CONFIG.dailyLimit':24};
 await db.query("insert into fixes_provider_accounts(account_id,label,session_encrypted,expires_at)values($1,'First',decode('01','hex'),now()+interval '1 hour'),($2,'Second',decode('02','hex'),now()+interval '1 hour')",[first,second]);
 for(let i=0;i<48;i++) {
  await db.exec('BEGIN');
  const candidate=await template(pick,limits);assert.equal(candidate.rows.length,1);
  assert.equal((await template(reserve,{...limits,id:candidate.rows[0].account_id})).rows.length,1);
  await db.exec('COMMIT');
 }
 assert.equal((await template(pick,limits)).rows.length,0,'both accounts stop at daily quota');
 assert.equal((await template(reserve,{...limits,id:first})).rows.length,0,'25th reservation rejected even without selection');
 const usage=await db.query('select download_count from fixes_provider_usage order by account_id');assert.deepEqual(usage.rows.map(r=>r.download_count),[24,24]);
 // Actual session-upsert SQL, same provider identity: relogin cannot reset usage or rate-limit block.
 const save=providerQueries.find(q=>q.includes('insert into fixes_provider_accounts'));
 await db.query("update fixes_provider_accounts set blocked_until=now()+interval '1 day' where account_id=$1",[first]);
 await template(save,{id:first,"input.label ?? ''":'Renamed',hex:'03','input.expires_at':new Date(Date.now()+3600000).toISOString()});
 assert.equal((await db.query('select download_count from fixes_provider_usage where account_id=$1',[first])).rows[0].download_count,24);
 assert.equal((await db.query('select blocked_until>now() as blocked from fixes_provider_accounts where account_id=$1',[first])).rows[0].blocked,true);
 await db.exec("update fixes_provider_usage set usage_day=usage_day-1");
 const nextDay=await template(pick,limits);assert.equal(nextDay.rows[0].account_id,second,'next day opens fresh quota, blocked account skipped');
 assert.equal((await template(reserve,{...limits,id:second})).rows[0].download_count,1);
 await db.query("update fixes_provider_accounts set status='disabled' where account_id=$1",[second]);
 assert.equal((await template(pick,limits)).rows.length,0,'disabled and blocked accounts unavailable');
 await db.query("update fixes_provider_accounts set status='ready',expires_at=now()-interval '1 second',blocked_until=null where account_id=$1",[second]);
 assert.equal((await template(pick,limits)).rows.length,0,'expired accounts unavailable');
 const privateAccounts=await db.query("select has_table_privilege('anon','fixes_provider_accounts','SELECT') as allowed");assert.equal(privateAccounts.rows[0].allowed,false);
 const audit=providerQueries.find(q=>q.includes('insert into fixes_provider_config'));assert.ok(audit);
 await db.exec("update fixes_provider_config set download_hosts='[]'");
 await template(audit,{"sql.json([url.hostname])":['new-cdn.test'],'url.hostname':'new-cdn.test'});
 await template(audit,{"sql.json([url.hostname])":['new-cdn.test'],'url.hostname':'new-cdn.test'});
 await template(audit,{"sql.json([url.hostname])":['second-cdn.test'],'url.hostname':'second-cdn.test'});
 assert.deepEqual((await db.query('select download_hosts from fixes_provider_config where id=1')).rows[0].download_hosts,['new-cdn.test','second-cdn.test'],'automatic host audit inserts, appends and deduplicates');
 const routeSource=await readFile(new URL('../src/routes/fixes.ts',import.meta.url),'utf8');
 const routeQueries=[...routeSource.matchAll(/(?:sql|tx)\s*`([\s\S]*?)`/g)].map(m=>m[1]);
 const catalog=routeQueries.find(q=>q.includes('app_id=any('));assert.ok(catalog);
 const catalogVars={q:'',"'%' + q + '%'":'%',tag:'',limit:24,'(Math.floor(page) - 1) * limit':0};
 assert.equal((await template(catalog,{...catalogVars,'idsRaw === null':true,installedArray:'{}'})).rows.length,1,'empty installed list is valid and all catalog games are returned');
 assert.equal((await template(catalog,{...catalogVars,'idsRaw === null':false,installedArray:'{}'})).rows.length,0,'empty My games filter returns none');
 assert.equal((await template(catalog,{...catalogVars,'idsRaw === null':false,installedArray:'{620,730}'})).rows.length,1,'installed AppIDs filter works');
 const bulk=providerQueries.find(q=>q.includes('with incoming as ('));assert.ok(bulk);
 const snapshot=JSON.stringify([{app_id:620,name:'Updated fixture',header_image:null,tags:[],fix_count:2},{app_id:730,name:'New fixture',header_image:null,tags:[],fix_count:1}]);
 // Reproduce the actual driver serializer: direct jsonb inference wraps JSON text as a JSON string.
 await assert.rejects(db.query('select * from jsonb_to_recordset($1::jsonb) as g(app_id bigint)',[postgresTypes.json.serialize(snapshot)]),error=>error.code==='22023');
 const textPayload=postgresTypes.string.serialize(snapshot);
 assert.ok(bulk.includes('${payload}::text::jsonb'),'batch explicitly binds text, not inferred jsonb');
 assert.equal((await template(bulk,{payload:textPayload})).rows[0].count,2,'actual driver text serializer produces a valid recordset');
 await db.exec("insert into fixes_catalog(app_id,name)values(999,'Old fixture')");
 await db.exec("update fixes_catalog set active=false where active=true");
 for(const game of JSON.parse(snapshot))await template(bulk,{payload:JSON.stringify([game])});
 const catalogAfter=await db.query('select app_id::text,name,active,fix_count from fixes_catalog order by app_id');
 assert.deepEqual(catalogAfter.rows,[{app_id:'620',name:'Updated fixture',active:true,fix_count:2},{app_id:'730',name:'New fixture',active:true,fix_count:1},{app_id:'999',name:'Old fixture',active:false,fix_count:0}]);
 await db.exec("update fixes_catalog set active=false where active=true");
 for(const game of JSON.parse(snapshot))await template(bulk,{payload:JSON.stringify([game])});
 assert.equal((await db.query('select count(*)::int as count from fixes_catalog')).rows[0].count,3,'bulk snapshot rerun does not duplicate rows');
 const beforeRollback=await db.query('select app_id::text,name,active from fixes_catalog order by app_id');
 await db.exec('BEGIN');await db.exec('update fixes_catalog set active=false where active=true');
 await template(bulk,{payload:JSON.stringify([{app_id:620,name:'Temporary',header_image:null,tags:[],fix_count:1}])});
 await assert.rejects(template(bulk,{payload:JSON.stringify([{app_id:0,name:'Invalid',header_image:null,tags:[],fix_count:1}])}));
 await db.exec('ROLLBACK');
 assert.deepEqual((await db.query('select app_id::text,name,active from fixes_catalog order by app_id')).rows,beforeRollback.rows,'failed batch rolls back all catalog changes');
 console.log("PASS: SQL patch rerun, private RLS tables, job deduplication, lease expiry, stale-owner rejection and ready publication; multiaccount 24/day, relogin quota preservation, rollover and account eligibility; automatic host audit deduplication; catalog empty/populated array filters (temporary PostgreSQL only).");
}finally{await db.close();}
