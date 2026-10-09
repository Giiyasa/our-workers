import { inflateRawSync } from "node:zlib";

export function luaZipCrc(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    return (crc^0xffffffff)>>>0;
}
/** Read only one Lua entry in memory; manifests and other files are never installed. */
export function extractLuaZip(bytes: Uint8Array, appId: number, maxLuaBytes: number): Uint8Array {
    const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const bad=()=>new Error("Unsupported Lua ZIP");
    let end=-1;
    for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--) {
        if(b.readUInt32LE(i)===0x06054b50 && i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
    }
    if(end<0 || b.readUInt16LE(end+4)!==0 || b.readUInt16LE(end+6)!==0) throw bad();
    const count=b.readUInt16LE(end+10), directorySize=b.readUInt32LE(end+12), directory=b.readUInt32LE(end+16);
    if(!count || count>5000 || b.readUInt16LE(end+8)!==count || directory+directorySize!==end) throw bad();
    type Entry={name:string; flags:number; method:number; crc:number; packed:number; size:number; offset:number};
    const candidates:Entry[]=[];
    let cursor=directory;
    for(let i=0;i<count;i++) {
        if(cursor+46>end || b.readUInt32LE(cursor)!==0x02014b50) throw bad();
        const nameLength=b.readUInt16LE(cursor+28), extra=b.readUInt16LE(cursor+30), comment=b.readUInt16LE(cursor+32);
        const next=cursor+46+nameLength+extra+comment;
        if(next>end || b.readUInt16LE(cursor+34)!==0) throw bad();
        const name=b.subarray(cursor+46,cursor+46+nameLength).toString("utf8");
        if(/\.lua$/i.test(name)) {
            if(name.includes("\\") || name.startsWith("/") || name.includes(":") || name.split("/").some(part=>part===".." || part==="." || !part)) throw bad();
            candidates.push({name,flags:b.readUInt16LE(cursor+8),method:b.readUInt16LE(cursor+10),crc:b.readUInt32LE(cursor+16),packed:b.readUInt32LE(cursor+20),size:b.readUInt32LE(cursor+24),offset:b.readUInt32LE(cursor+42)});
        }
        cursor=next;
    }
    if(cursor!==end) throw bad();
    const exact=candidates.filter(entry=>entry.name.split("/").pop()===`${appId}.lua`);
    const selected=exact.length===1?exact[0]:exact.length===0&&candidates.length===1?candidates[0]:null;
    if(!selected) throw bad();
    const e=selected;
    if(e.flags&1 || ![0,8].includes(e.method) || !e.size || e.size>maxLuaBytes || e.offset+30>directory || b.readUInt32LE(e.offset)!==0x04034b50) throw bad();
    const nameLength=b.readUInt16LE(e.offset+26),extra=b.readUInt16LE(e.offset+28),start=e.offset+30+nameLength+extra;
    if(start+e.packed>directory || b.readUInt16LE(e.offset+6)!==e.flags || b.readUInt16LE(e.offset+8)!==e.method || b.subarray(e.offset+30,e.offset+30+nameLength).toString("utf8")!==e.name) throw bad();
    const packed=b.subarray(start,start+e.packed);
    const output=e.method===0?packed:inflateRawSync(packed,{maxOutputLength:maxLuaBytes});
    if(output.length!==e.size || luaZipCrc(output)!==e.crc) throw bad();
    return new Uint8Array(output);
}
