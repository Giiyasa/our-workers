import {readFile} from 'node:fs/promises';
import {FIXES_CONFIG} from '../src/fixes-config.mjs';
const worker=new URL(process.env.FIXES_WORKER_URL || FIXES_CONFIG.worker);
if(worker.protocol!=='https:' || worker.username || worker.password)throw new Error('HTTPS Worker URL required');
let token=process.env.FIXES_ADMIN_WRITE_TOKEN;
if(!token){try{const vars=await readFile(new URL('../.dev.vars',import.meta.url),'utf8');const match=vars.match(/^\s*WRITE_TOKEN\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))/m);token=(match?.[1]??match?.[2]??match?.[3])?.trim();}catch{}}
if(!token)throw new Error('Existing WRITE_TOKEN required in .dev.vars or FIXES_ADMIN_WRITE_TOKEN');
const response=await fetch(new URL('/api/admin/home/sync',worker),{method:'POST',redirect:'error',headers:{'X-Write-Token':token},signal:AbortSignal.timeout(90000)});
const data=await response.json().catch(()=>({}));
console.log(JSON.stringify(data,null,2));
if(!response.ok || data.ok===false){
 const hints={'42P01':'Tabel belum tersedia. Jalankan HOME_FEED_PATCH.sql.',
 '23514':'Constraint section lama. Jalankan HOME_QUALITY_PATCH.sql.',
 '42501':'Role koneksi database tidak punya izin tabel.',
 'CONNECTION_CLOSED':'Koneksi database terputus.',
 '57014':'Query database timeout.'};
 const hint=hints[data.sections?.db_code];
 if(hint)console.error(hint);
 console.error(`Home sync failed: HTTP ${response.status}. Data sebelumnya dipertahankan.`);
 process.exitCode=1;
}
