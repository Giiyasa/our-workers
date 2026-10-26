// Real PostgreSQL semantics in an isolated PGlite instance; no production access.
import {PGlite} from '@electric-sql/pglite';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../src/lib/asset-write.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {writeAssetLua,ASSET_HEX_CHUNK_SIZE}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const db=new PGlite();
try {
 await db.exec(`create table game_assets(game_id bigint primary key,lua_data bytea,encryption_version integer);
 create table audit_hits(game_id bigint);
 create function audit_asset() returns trigger language plpgsql as $$begin insert into audit_hits values(new.game_id);return new;end;$$;
 create trigger audit_asset after insert or update on game_assets for each row execute function audit_asset();`);
 let maxParameter=0;
 const adapter=tx=>async(strings,...values)=>{
  for(const value of values)if(typeof value==='string')maxParameter=Math.max(maxParameter,value.length);
  const sql=strings.reduce((text,part,index)=>text+(index?'$'+index:'')+part,'');
  return (await tx.query(sql,values)).rows;
 };
 for(const size of [1,16384,16385,248645,1000033]){
  const bytes=Buffer.alloc(size);for(let i=0;i<size;i++)bytes[i]=i%251;
  await db.transaction(async tx=>writeAssetLua(adapter(tx),1222670,bytes.toString('hex')));
  const {rows}=await db.query("select encode(lua_data,'hex') as hex,encryption_version from game_assets where game_id=1222670");
  assert.equal(rows[0].hex,bytes.toString('hex'));assert.equal(rows[0].encryption_version,1);
  assert.equal((await db.query("select to_regclass('pg_temp.asset_lua_chunks') as name")).rows[0].name,null);
 }
 assert.equal((await db.query('select count(*)::int as n from audit_hits')).rows[0].n,5);
 const before=(await db.query("select encode(lua_data,'hex') as hex from game_assets")).rows[0].hex;
 await assert.rejects(db.transaction(async tx=>{await writeAssetLua(adapter(tx),1222670,'ab'.repeat(248645));throw Error('force rollback');}));
 assert.equal((await db.query("select encode(lua_data,'hex') as hex from game_assets")).rows[0].hex,before);
 assert.equal((await db.query('select count(*)::int as n from audit_hits')).rows[0].n,5);
 assert.ok(maxParameter<=ASSET_HEX_CHUNK_SIZE);
 console.log('PASS: byte-for-byte insert/upsert at 1 B, 16 KiB boundaries, reported 248645 B and max asset size; one trigger per publication; rollback; temp cleanup; max parameter '+maxParameter+' B.');
}finally{await db.close();}
