import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const folder=await mkdtemp(path.join(tmpdir(),"fixes-admin-test-"));
try{
 const preload=path.join(folder,"preload.mjs");
 await writeFile(preload,`globalThis.fetch=async(url,init)=>{console.log(JSON.stringify({path:new URL(url).pathname,body:init.body?JSON.parse(init.body):null}));if(new URL(url).pathname.endsWith('/sync'))return Response.json({ok:false,code:'PROVIDER_AUTH',upstream_status:403,error:'synthetic-secret-body'},{status:503});return Response.json({ok:true,invalidated:true});};`);
 const run=(args,input)=>spawnSync(process.execPath,["--import",pathToFileURL(preload).href,"scripts/fixes-admin.mjs",...args],{encoding:"utf8",input,env:{...process.env,FIXES_ADMIN_WRITE_TOKEN:"synthetic-admin-secret",FIXES_WORKER_URL:"https://fixture.test"}});
 const invalidated=run(["invalidate","fixture","fix"]);assert.equal(invalidated.status,0,invalidated.stderr);assert.ok(invalidated.stdout.includes('/api/admin/fixes/invalidate'));assert.ok(!invalidated.stdout.includes('synthetic-admin-secret'));
 const malformed=run(["session"],'{"access_token":"synthetic-sensitive-token",BROKEN');assert.equal(malformed.status,1);assert.ok(malformed.stderr.includes('Session input must be valid JSON'));assert.ok(!malformed.stderr.includes('synthetic-sensitive-token'));
 const refresh=run(['refresh','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);assert.equal(refresh.status,0,refresh.stderr);assert.ok(refresh.stdout.includes('"account_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'));
 const noAccount=run(['refresh']);assert.equal(noAccount.status,1);assert.ok(noAccount.stderr.includes('refresh <account-id>'));
 const hosts=run(['hosts','packages.test,redirect.test']);assert.equal(hosts.status,0,hosts.stderr);assert.ok(hosts.stdout.includes('/api/admin/fixes/config'));assert.ok(hosts.stdout.includes('"download_hosts":["packages.test","redirect.test"]'));
 const disabled=run(['disable','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);assert.equal(disabled.status,0);assert.ok(disabled.stdout.includes('"enabled":false'));
 const syncFailure=run(['sync']);assert.equal(syncFailure.status,1);assert.ok(syncFailure.stderr.includes('LuaTools HTTP 403'));assert.ok(!syncFailure.stderr.includes('synthetic-secret-body'));
 console.log('PASS: multiaccount refresh, host settings, account disable and invalidation CLI routing and malformed-session secrecy (stubbed network only).');
}finally{if(!path.resolve(folder).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(folder).startsWith("fixes-admin-test-"))throw Error("Unexpected test cleanup target");await rm(folder,{recursive:true,force:true});}
