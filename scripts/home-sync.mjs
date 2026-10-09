import {readFile} from 'node:fs/promises';
import {FIXES_CONFIG} from '../src/fixes-config.mjs';
const worker=new URL(process.env.FIXES_WORKER_URL || FIXES_CONFIG.worker);
if(worker.protocol!=='https:' || worker.username || worker.password)throw new Error('HTTPS Worker URL required');
let token=process.env.FIXES_ADMIN_WRITE_TOKEN;
if(!token){try{const vars=await readFile(new URL('../.dev.vars',import.meta.url),'utf8');const match=vars.match(/^\s*WRITE_TOKEN\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))/m);token=(match?.[1]??match?.[2]??match?.[3])?.trim();}catch{}}
if(!token)throw new Error('Existing WRITE_TOKEN required in .dev.vars or FIXES_ADMIN_WRITE_TOKEN');
const response=await fetch(new URL('/api/admin/home/sync',worker),{method:'POST',redirect:'error',headers:{'X-Write-Token':token},signal:AbortSignal.timeout(90000)});
if(!response.ok)throw new Error(`Home sync HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(),null,2));
