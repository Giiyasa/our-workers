import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const input = path.resolve('outputs/ryuu_compare_2026-10-16_2/games_missing_template.csv');
const outdir = path.resolve('outputs/ryuu_compare_2026-10-16_2/enriched_2026-10-16');
fs.mkdirSync(outdir, { recursive: true });
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
const columns = ['app_id','name','image','description','genre','release_date','categories','publishers'];
function parseCSV(text) {
    const rows=[]; let row=[],cell='',quoted=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){
        const char=text[i];
        if(char==='"'){if(quoted && text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
        else if(char===','&&!quoted){row.push(cell);cell='';}
        else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}
        else cell+=char;
    }
    if(cell||row.length){row.push(cell);rows.push(row);}
    if(quoted)throw new Error('Unclosed CSV quotes');return rows;
}
const parsed=parseCSV(fs.readFileSync(input,'utf8'));
if(JSON.stringify(parsed[0])!==JSON.stringify(columns))throw new Error('Template header mismatch');
const rows=parsed.slice(1).map(values=>Object.fromEntries(columns.map((key,i)=>[key,values[i]??''])));
if(new Set(rows.map(row=>row.app_id)).size!==rows.length)throw new Error('Duplicate source AppIDs');
const checkpointPath=path.join(outdir,'checkpoint.json');
const state=fs.existsSync(checkpointPath)?JSON.parse(fs.readFileSync(checkpointPath,'utf8')):{sourceHash,batches:{},proxy:{},direct:{},regional:{}};
if(state.sourceHash!==sourceHash)throw new Error('Checkpoint source differs');
state.regional??={};
const checkpoint=()=>fs.writeFileSync(checkpointPath,JSON.stringify(state));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stamp=()=>new Date().toISOString();
async function request(url){
    try{
        const response=await fetch(url,{signal:AbortSignal.timeout(12000),redirect:'follow',headers:{accept:'application/json'}});
        if(!response.ok){await response.body?.cancel();return {status:response.status,retryAfter:Number(response.headers.get('retry-after'))||0};}
        const text=await response.text();if(text.length>8_000_000)return {status:200,error:'RESPONSE_TOO_LARGE'};
        try{return {status:200,data:JSON.parse(text)};}catch{return {status:200,error:'INVALID_JSON'};}
    }catch{return {status:0,error:'NETWORK_OR_TIMEOUT'};}
}
function compactDirect(data,id){
    const entry=data?.[id];
    if(entry?.success!==true)return {error:'NOT_PUBLIC_IN_REGION'};
    if(Number(entry.data?.steam_appid)!==Number(id))return {error:'REDIRECTED_APPID',returnedAppId:entry.data?.steam_appid};
    const d=entry.data;
    return {appid:Number(id),description:d.short_description??'',genre:Array.isArray(d.genres)?d.genres.map(x=>x.description).filter(Boolean):null,
        categories:Array.isArray(d.categories)?d.categories.map(x=>x.description).filter(Boolean):null,
        publishers:Array.isArray(d.publishers)?d.publishers.filter(x=>typeof x==='string'):null,
        releaseDate:d.release_date?.date??'',image:d.header_image??''};
}
function isoDate(value){
    if(typeof value!=='string')return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
    if(!/^(?:[A-Za-z]{3} \d{1,2}, \d{4}|\d{1,2} [A-Za-z]{3},? \d{4})$/.test(value))return '';
    const time=Date.parse(value+' UTC');return Number.isFinite(time)?new Date(time).toISOString().slice(0,10):'';
}
async function bulk(){
    const categoriesFile=path.join(outdir,'steam_categories.json');
    if(!fs.existsSync(categoriesFile)){
        const r=await request('https://api.steampowered.com/IStoreBrowseService/GetStoreCategories/v1/?language=english');
        if(!Array.isArray(r.data?.response?.categories))throw new Error('Official Steam category labels unavailable');
        fs.writeFileSync(categoriesFile,JSON.stringify(r.data.response.categories));
    }
    for(let i=0;i<rows.length;i+=100){
        const ids=rows.slice(i,i+100).map(row=>Number(row.app_id)),key=String(i/100);
        if(state.batches[key]?.ok)continue;
        const payload={ids:ids.map(appid=>({appid})),context:{language:'english',country_code:'US'},data_request:{include_basic_info:true,include_assets:true,include_release:true,include_categories:true}};
        const url='https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json='+encodeURIComponent(JSON.stringify(payload));
        let r;
        for(let attempt=0;attempt<3;attempt++){r=await request(url);if(Array.isArray(r.data?.response?.store_items))break;await sleep(2000*(attempt+1));}
        state.batches[key]={ok:Array.isArray(r.data?.response?.store_items),status:r.status,items:r.data?.response?.store_items??[],fetchedAt:stamp()};
        checkpoint();console.log(JSON.stringify({phase:'batch',done:Math.min(i+100,rows.length),total:rows.length,ok:state.batches[key].ok}));
        await sleep(250);
    }
}
let nextRequest=0,blockedUntil=0;
async function limitedRequest(url,spacing){
    const slot=Math.max(Date.now(),nextRequest,blockedUntil);nextRequest=slot+spacing;
    await sleep(Math.max(0,slot-Date.now()));
    const r=await request(url);
    if(r.status===429)blockedUntil=Math.max(blockedUntil,Date.now()+Math.min(30000,Math.max(5000,r.retryAfter*1000)));
    return r;
}
async function workers(items,concurrency,callback){let next=0;await Promise.all(Array.from({length:concurrency},async()=>{while(next<items.length){const index=next++;await callback(items[index],index);}}));}
async function proxy(){
    const pending=rows.filter(row=>!state.proxy[row.app_id]);let done=0;
    console.log(JSON.stringify({phase:'proxy_start',cached:rows.length-pending.length,pending:pending.length}));
    await workers(pending,4,async row=>{
        let r;for(let attempt=0;attempt<2;attempt++){
            r=await limitedRequest('https://lua.tools/api/steam/details?appid='+row.app_id,180);
            if(r.status===200&&r.data)break;
            if(![0,429,500,502,503,504].includes(r.status))break;
            await sleep(1500*(attempt+1));
        }
        const valid=r.data&&Number(r.data.appid)===Number(row.app_id);
        state.proxy[row.app_id]={status:r.status,data:valid?r.data:null,error:valid?null:r.error??(r.data?'APPID_MISMATCH':'NO_PUBLIC_DETAILS'),fetchedAt:stamp()};
        done++;if(done%25===0){checkpoint();console.log(JSON.stringify({phase:'proxy',done:rows.length-pending.length+done,total:rows.length,success:Object.values(state.proxy).filter(x=>x.data).length}));}
    });checkpoint();
}
const categoryMap=()=>new Map(JSON.parse(fs.readFileSync(path.join(outdir,'steam_categories.json'),'utf8')).map(row=>[Number(row.categoryid),row.display_name||row.internal_name]));
function merged(){
    const batchItems=new Map(Object.values(state.batches).flatMap(batch=>batch.items).filter(x=>x.success===1&&x.appid>0).map(item=>[String(item.appid),item]));
    const regionalFile=path.join(outdir,'regional_batches.json');
    if(fs.existsSync(regionalFile))for(const [id,item] of Object.entries(JSON.parse(fs.readFileSync(regionalFile,'utf8'))))if(!batchItems.has(id))batchItems.set(id,item);
    const labels=categoryMap();
    return rows.map(original=>{
        const row={...original},sources={},issues=[];
        const put=(key,value,source)=>{if(!row[key]&&value!==null&&value!==undefined&&value!==''){row[key]=Array.isArray(value)?JSON.stringify([...new Set(value)]):String(value);sources[key]=source;}};
        const id=row.app_id,b=batchItems.get(id),p=state.proxy[id]?.data;
        if(p?.delisted===true)issues.push('LUATOOLS_MARKED_DELISTED');
        if(state.direct[id]?.status===429)issues.push('STEAM_DETAILS:HTTP_429_RATE_LIMIT');
        else if(state.direct[id]?.error)issues.push('STEAM_DETAILS:'+state.direct[id].error);
        if(state.proxy[id]?.error)issues.push('LUATOOLS:'+state.proxy[id].error);
        if(b){
            const batchSource=b._country?'steam_batch_'+b._country:'steam_batch';
            put('description',b.basic_info?.short_description,batchSource);
            if(Array.isArray(b.basic_info?.publishers))put('publishers',b.basic_info.publishers.map(x=>x.name).filter(Boolean),batchSource);
            const categoryIds=[...new Set(Object.values(b.categories??{}).filter(Array.isArray).flat())];
            if(b.categories)put('categories',categoryIds.flatMap(id=>labels.has(Number(id))?[labels.get(Number(id))]:[]),batchSource);
            for(const id of categoryIds)if(!labels.has(Number(id)))issues.push('UNKNOWN_CATEGORY_ID:'+id);
            const timestamp=b.release?.steam_release_date;
            if(Number.isFinite(timestamp)&&timestamp>0)put('release_date',new Date(timestamp*1000).toISOString().slice(0,10),batchSource);
            if(b.assets?.header&&b.assets?.asset_url_format)put('image','https://shared.akamai.steamstatic.com/store_item_assets/'+b.assets.asset_url_format.replace('${FILENAME}',b.assets.header),batchSource);
        }
        if(p){put('genre',Array.isArray(p.genres)?p.genres.filter(x=>typeof x==='string'):null,'luatools');put('release_date',isoDate(p.releaseDate),'luatools');put('image',p.headerImage,'luatools');}
        for(const [source,entry] of [['steam_appdetails',state.direct[id]],['steam_appdetails_regional',state.regional[id]]]){
            const d=entry?.data;if(!d)continue;
            put('description',d.description,source);put('genre',d.genre,source);put('categories',d.categories,source);put('publishers',d.publishers,source);put('release_date',isoDate(d.releaseDate),source);put('image',d.image,source);
        }
        const missing=columns.filter(key=>key!=='app_id'&&(!row[key]||row[key]==='[]'));
        if(missing.length&&!state.direct[id]&&Object.values(state.direct).some(entry=>entry.status===429))issues.push('STEAM_DETAILS_DEFERRED_AFTER_RATE_LIMIT');
        return {row,sources,missing,issues,batchSuccess:!!b,proxyStatus:state.proxy[id]?.status??'',directStatus:state.direct[id]?.status??'',redirectedTo:state.direct[id]?.returnedAppId??''};
    });
}
async function regionalBulk(){
    const file=path.join(outdir,'regional_batches.json');
    const recovered=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
    const original=new Set(Object.values(state.batches).flatMap(batch=>batch.items).filter(x=>x.success===1&&x.appid>0).map(item=>String(item.appid)));
    for(const country of ['DE','JP','ID','CN']){
        const pending=rows.filter(row=>!original.has(row.app_id)&&!recovered[row.app_id]);
        for(let i=0;i<pending.length;i+=100){
            const payload={ids:pending.slice(i,i+100).map(row=>({appid:Number(row.app_id)})),context:{language:'english',country_code:country},data_request:{include_basic_info:true,include_assets:true,include_release:true,include_categories:true}};
            const r=await request('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json='+encodeURIComponent(JSON.stringify(payload)));
            for(const item of r.data?.response?.store_items??[])if(item.success===1&&item.appid>0)recovered[item.appid]={...item,_country:country};
            fs.writeFileSync(file,JSON.stringify(recovered));await sleep(250);
        }
        console.log(JSON.stringify({phase:'regional_batch',country,recovered:Object.keys(recovered).length}));
    }
}
async function direct(){
    // Fill genuinely missing metadata; do not query already complete rows.
    const pending=merged().filter(item=>item.missing.length&&!state.direct[item.row.app_id]);let done=0;
    console.log(JSON.stringify({phase:'direct_start',pending:pending.length}));
    await workers(pending,3,async ({row})=>{
        let r;for(let attempt=0;attempt<2;attempt++){
            r=await limitedRequest('https://store.steampowered.com/api/appdetails?appids='+row.app_id+'&cc=us&l=english&filters=basic,genres,categories,publishers,release_date',350);
            if(r.status===200)break;
            if(![0,429,500,502,503,504].includes(r.status))break;
            await sleep(1500*(attempt+1));
        }
        const data=compactDirect(r.data,row.app_id);
        state.direct[row.app_id]={status:r.status,data:data.error?null:data,error:data.error??r.error??null,returnedAppId:data.returnedAppId??null,fetchedAt:stamp()};
        done++;if(done%25===0){checkpoint();console.log(JSON.stringify({phase:'direct',done,total:pending.length}));}
    });checkpoint();
}
function csvText(header,records){const escape=value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};return '\uFEFF'+[header,...records.map(row=>header.map(key=>row[key]??''))].map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';}
function finalize(){
    const items=merged();const file=path.join(outdir,'games_missing_completed.csv');
    fs.writeFileSync(file,csvText(columns,items.map(item=>item.row)));
    const audit=items.map(item=>({app_id:item.row.app_id,name:item.row.name,fields_filled:Object.keys(item.sources).join(';'),missing_fields:item.missing.join(';'),field_sources:JSON.stringify(item.sources),batch_success:item.batchSuccess,proxy_http:item.proxyStatus,steam_details_http:item.directStatus,steam_returned_other_appid:item.redirectedTo,notes:item.issues.join(';')}));
    fs.writeFileSync(path.join(outdir,'enrichment_audit.csv'),csvText(Object.keys(audit[0]),audit));
    const after=parseCSV(fs.readFileSync(file,'utf8'));
    if(JSON.stringify(after[0])!==JSON.stringify(columns)||after.length!==rows.length+1)throw new Error('Output CSV validation failed');
    for(let i=0;i<rows.length;i++)for(let j=0;j<columns.length;j++){
        if(rows[i][columns[j]]&&rows[i][columns[j]]!==after[i+1][j])throw new Error('Existing source value changed');
        if(['genre','categories','publishers'].includes(columns[j])&&after[i+1][j]&&!Array.isArray(JSON.parse(after[i+1][j])))throw new Error('Invalid JSON array');
    }
    if(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex')!==sourceHash)throw new Error('Original CSV changed');
    const summary={total:rows.length,enriched:items.filter(x=>Object.keys(x.sources).some(key=>x.row[key]&&x.row[key]!=='[]')).length,complete:items.filter(x=>!x.missing.length).length,
        missing_by_field:Object.fromEntries(columns.filter(k=>k!=='app_id').map(k=>[k,items.filter(x=>!x.row[k]||x.row[k]==='[]').length])),
        filled_by_field:Object.fromEntries(columns.map(k=>[k,items.filter(x=>k in x.sources&&x.row[k]&&x.row[k]!=='[]').length])),
        no_api_metadata:items.filter(x=>!x.batchSuccess&&!state.proxy[x.row.app_id]?.data&&!state.direct[x.row.app_id]?.data).length,
        redirected_appids:items.filter(x=>x.redirectedTo).map(x=>({app_id:x.row.app_id,returned_appid:x.redirectedTo})),
        unchanged_rows:items.filter(x=>!Object.keys(x.sources).some(key=>x.row[key]&&x.row[key]!=='[]')).length,
        marked_delisted:items.filter(x=>state.proxy[x.row.app_id]?.data?.delisted===true).length,
        steam_details_checked:Object.keys(state.direct).length,
        steam_details_rate_limited:Object.values(state.direct).filter(x=>x.status===429).length,
        steam_details_deferred:items.filter(x=>x.issues.includes('STEAM_DETAILS_DEFERRED_AFTER_RATE_LIMIT')).length,
        regional_batch_recovered:fs.existsSync(path.join(outdir,'regional_batches.json'))?Object.keys(JSON.parse(fs.readFileSync(path.join(outdir,'regional_batches.json'),'utf8'))).length:0,
        source_sha256:sourceHash,completed_at:stamp()};
    fs.writeFileSync(path.join(outdir,'summary.json'),JSON.stringify(summary,null,2));
    const lines=['# Report pelengkapan metadata Ryuu','','Sumber awal: '+input,'','Metadata diambil dari API publik Steam dan LuaTools. AppID, nama, dan semua nilai awal yang sudah terisi dipertahankan. Metadata tidak ditebak; tags Ryuu tidak digunakan sebagai genre.','',
        `- Baris: ${summary.total}`,`- Mendapat metadata tambahan nonkosong: ${summary.enriched}`,`- Semua kolom terisi dan array tidak kosong: ${summary.complete}`,`- Tanpa tambahan informasi nonkosong: ${summary.unchanged_rows}`,`- Ditandai delisted oleh LuaTools: ${summary.marked_delisted}`,`- AppID dipulihkan melalui batch regional DE/JP/ID/CN: ${summary.regional_batch_recovered}`,'',
        '| Kolom | Diisi | Masih kosong / array kosong |','|---|---:|---:|',...columns.filter(k=>k!=='app_id').map(k=>`| ${k} | ${summary.filled_by_field[k]} | ${summary.missing_by_field[k]} |`),'',
        'Tanggal rilis hanya diisi jika berupa tanggal pasti. Game belum rilis, dihapus, privat, regional, atau metadata kosong dapat tetap memiliki kolom kosong. Array genre/categories/publishers berupa JSON, sesuai format katalog CSV sebelumnya.','',
        `Steam App Details membatasi HTTP 429 setelah 200 respons HTTP 200. Pengulangan dihentikan agar tidak terus meminta ke endpoint yang dibatasi. App Details diperiksa untuk ${summary.steam_details_checked} AppID; ${summary.steam_details_rate_limited} dibatasi dan ${summary.steam_details_deferred} baris yang masih belum lengkap ditunda untuk sumber App Details. Seluruh ${rows.length} AppID sudah diperiksa melalui batch Steam dan detail LuaTools. Ini hasil enrichment sebagian; kolom belum terisi tidak berarti metadata pasti tidak ada.`, '',
        'Kategori diambil dari ID kategori Steam dan label resmi GetStoreCategories. Publisher, deskripsi dan tanggal rilis terutama berasal dari batch Steam; genre terutama dari detail LuaTools. App Details menjadi pelengkap. Semua field memiliki provenance pada enrichment_audit.csv.','',
        `Respons App Details yang mengarah ke AppID lain tidak disalin: ${summary.redirected_appids.length} kasus (lihat audit).`,'','Sumber API:',
        '- https://api.steampowered.com/IStoreBrowseService/GetItems/v1/',
        '- https://api.steampowered.com/IStoreBrowseService/GetStoreCategories/v1/',
        '- https://lua.tools/api/steam/details?appid=APPID',
        '- https://store.steampowered.com/api/appdetails?appids=APPID&cc=us&l=english','',
        'CSV awal dan database tidak diubah. Belum dilakukan import ke Supabase. SHA-256 sumber: '+sourceHash,''];
    fs.writeFileSync(path.join(outdir,'report.md'),lines.join('\n'));
    console.log(JSON.stringify({phase:'completed',outdir,...summary}));
}
console.log(JSON.stringify({phase:'start',rows:rows.length,outdir}));
if(process.argv.includes('--regional-only'))await regionalBulk();
else if(process.argv.includes('--finalize-only'))finalize();
else {await bulk();await proxy();await direct();finalize();}
