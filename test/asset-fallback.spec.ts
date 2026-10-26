import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { encryptAsset, decryptAsset } from "../src/lib/asset-crypto";
import { fetchProviderLua, readLua, readLuaToolsPackage } from "../src/lib/asset-providers";
import { providerAccessToken, withProviderAccount, FixesFailure } from "../src/lib/fixes-provider";
import { deflateRawSync } from "node:zlib";
import { luaZipCrc } from "../src/lib/lua-archive";
import type { Sql } from "../src/lib/db";

vi.mock("../src/lib/fixes-provider", async importOriginal => ({
    ...await importOriginal<typeof import("../src/lib/fixes-provider")>(),
    providerAccessToken: vi.fn(),
    withProviderAccount: vi.fn(),
}));
beforeEach(()=>{
    vi.mocked(providerAccessToken).mockReset().mockRejectedValue(new Error("no provider account"));
    vi.mocked(withProviderAccount).mockImplementation(async (sql,env,operation)=>operation(await providerAccessToken(sql,env)));
});
const key = "11".repeat(32); // synthetic test key, never production credentials
const lua = 'addappid(620, 0, "fixture")\n';
const env = { RYUU_AUTH_CODE: "test-code", HUBCAP_API_KEYS: "[]" } as Env;
afterEach(() => vi.unstubAllGlobals());

describe("encrypted provider assets", () => {
	it("SGA1 is compatible with the nonce/ciphertext/tag layout and rejects wrong keys", async () => {
		const bytes = new TextEncoder().encode(lua);
		const encrypted = await encryptAsset(bytes, key);
		expect(new TextDecoder().decode(encrypted.subarray(0, 4))).toBe("SGA1");
		expect(encrypted[4]).toBe(1);
		expect(encrypted.length).toBe(bytes.length + 33);
		const hex = Array.from(encrypted, (byte) => byte.toString(16).padStart(2, "0")).join("");
		expect(await decryptAsset(hex, key)).toEqual(bytes);
		await expect(decryptAsset(hex, "22".repeat(32))).rejects.toThrow();
		const other = await encryptAsset(bytes, key);
		expect(other.subarray(5, 17)).not.toEqual(encrypted.subarray(5, 17));
	});
	it("rejects HTML/JSON masquerading as a successful provider download", async () => {
		await expect(readLua(new Response('<html>not found</html>'))).rejects.toThrow();
		await expect(readLua(new Response('{"error":"missing"}'))).rejects.toThrow();
	});
});

describe("provider ordering", () => {
	it("uses provider 2 plaintext and URL encodes the auth code", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(lua));
		vi.stubGlobal("fetch", fetcher);
		const result = await fetchProviderLua({} as Sql, { ...env, RYUU_AUTH_CODE: "a&b" }, 620);
		expect(result.source).toBe("provider_2");
		expect(new TextDecoder().decode(result.bytes)).toBe(lua);
		const called = new URL(String(fetcher.mock.calls[0][0]));
		expect(called.searchParams.get("auth_code")).toBe("a&b");
	});
	it.each(["http503", "timeout", "network", "bad_file", "stream_error", "missing_key"])("falls back from Ryuu %s to Luie", async failure => {
		vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
		const fetcher = vi.fn(async (raw: string | URL) => {
			if (new URL(raw).hostname !== "generator.ryuu.lol") return new Response(lua);
			if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
			if (failure === "network") throw new TypeError("Connection failed");
			if (failure === "stream_error") return new Response(new ReadableStream({start(controller){controller.error(new TypeError("Read failed"));}}));
			return new Response(failure === "bad_file" ? "<html>Error</html>" : "unavailable", {status: failure === "http503" ? 503 : 200});
		});
		vi.stubGlobal("fetch", fetcher);
		const result = await fetchProviderLua({} as Sql, {...env, RYUU_AUTH_CODE: failure === "missing_key" ? "" : env.RYUU_AUTH_CODE}, 620);
		expect(result.source).toBe("luatools_luie");
		expect(new TextDecoder().decode(result.bytes)).toBe(lua);
		expect(fetcher).toHaveBeenCalledTimes(failure === "missing_key" ? 1 : 2);
	});
	it("retains Ryuu failure when Luie has no result and Hubcap is unconfigured", async () => {
		vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
		vi.stubGlobal("fetch", vi.fn(async(raw: string | URL) => new Response(null, {status:new URL(raw).hostname === "generator.ryuu.lol" ? 503 : 404})));
		await expect(fetchProviderLua({} as Sql, env, 620)).rejects.toMatchObject({code:"PROVIDER_UNAVAILABLE",message:expect.stringContaining("Ryuu")});
	});
	it.each(["hubcap_success", "ryuu_outage", "all_missing"])("completes the provider chain: %s", async scenario => {
		// Minimal reservation DB fixture; no real provider accounts or quota are touched.
		const query = Object.assign((strings: TemplateStringsArray | unknown[]) => {
			if (!("raw" in strings)) return strings;
			const text = strings.join("?");
			if (text.includes("select provider_key_id from provider_key_usage") || text.includes("returning provider_key_id") || text.includes("returning reservation_id"))
				return Promise.resolve([{provider_key_id:"fixture",reservation_id:"fixture"}]);
			return Promise.resolve([]);
		}, {begin: async (operation: (tx: unknown) => unknown) => operation(query)});
		vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
		const fetcher=vi.fn(async(raw: string | URL) => {
			const host=new URL(raw).hostname;
			if (host === "generator.ryuu.lol") return new Response(null,{status:scenario === "all_missing" ? 404 : 503});
			if (host === "hubcapmanifest.com" && scenario === "hubcap_success") return new Response(lua);
			return new Response(null,{status:404});
		});
		vi.stubGlobal("fetch",fetcher);
		const result=fetchProviderLua(query as unknown as Sql,{...env,HUBCAP_API_KEYS:JSON.stringify([{id:"fixture",key:"synthetic"}])},620);
		if (scenario === "hubcap_success") {
			expect(await result).toMatchObject({source:"provider_3",bytes:new TextEncoder().encode(lua)});
		} else {
			await expect(result).rejects.toMatchObject({code:scenario === "all_missing" ? "ASSET_NOT_FOUND" : "PROVIDER_UNAVAILABLE"});
		}
		expect(fetcher.mock.calls.map(([raw])=>new URL(raw).hostname)).toEqual(["generator.ryuu.lol","lua.tools","hubcapmanifest.com"]);
	});
	it("preserves the LuaTools failure when Hubcap is also unconfigured", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"Game not found"}', { status: 404 })));
		await expect(fetchProviderLua({} as Sql, env, 620)).rejects.toMatchObject({ code: "LUIE_UNAVAILABLE" });
	});
});

function zip(entries: {name:string; text:string; method?:number}[]): Uint8Array {
    const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
    for(const entry of entries){
        const name=Buffer.from(entry.name),content=Buffer.from(entry.text),method=entry.method??8;
        const packed=method===8?deflateRawSync(content):content,crc=luaZipCrc(content);
        const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);
        local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
        locals.push(local,name,packed);
        const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(method,10);
        directory.writeUInt32LE(crc,16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(content.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
        central.push(directory,name);offset+=30+name.length+packed.length;
    }
    const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
    return Buffer.concat([...locals,directory,end]);
}
describe("LuaTools fourth source",()=>{
    it.each([
        [401, 'LUIE_PROVIDER_AUTH'],
        [403, 'LUIE_PROVIDER_AUTH'],
        [429, 'LUIE_PROVIDER_LIMIT'],
        [503, 'LUIE_HTTP_ERROR'],
    ])("keeps the Luie HTTP %s failure visible when Hubcap fails",async(status,code)=>{
        vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
        vi.stubGlobal("fetch",vi.fn(async(raw:string|URL)=>new Response(null,{status:new URL(raw).hostname==='generator.ryuu.lol'?404:status})));
        await expect(fetchProviderLua({} as Sql,env,620)).rejects.toMatchObject({code,message:expect.stringContaining('Hubcap')});
    });
    it("reports an unavailable LuaTools account pool separately from Hubcap quota",async()=>{
        vi.mocked(providerAccessToken).mockRejectedValue(new FixesFailure('PROVIDER_UNAVAILABLE'));
        vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status:404})));
        await expect(fetchProviderLua({} as Sql,env,620)).rejects.toMatchObject({code:'LUIE_PROVIDER_UNAVAILABLE',message:expect.stringContaining('Tidak ada akun LuaTools yang siap')});
    });
    it("preserves invalid Luie package errors",async()=>{
        vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
        vi.stubGlobal("fetch",vi.fn(async(raw:string|URL)=>new URL(raw).hostname==='generator.ryuu.lol'?new Response(null,{status:404}):new Response('<html>error</html>')));
        await expect(fetchProviderLua({} as Sql,env,620)).rejects.toMatchObject({code:'LUIE_PROVIDER_BAD_FILE'});
    });
    it("runs after Ryuu 404 and before Hubcap with the existing provider account",async()=>{
        vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic-luatools",accountId:"fixture",version:"1"});
        const fetcher=vi.fn(async(raw:string|URL)=>new URL(raw).hostname==="generator.ryuu.lol"?new Response(null,{status:404}):new Response(zip([{name:"620.lua",text:lua},{name:"manifest/123.manifest",text:"ignored"}])));
        vi.stubGlobal("fetch",fetcher);
        const result=await fetchProviderLua({} as Sql,env,620);
        expect(result.source).toBe("luatools_luie");expect(new TextDecoder().decode(result.bytes)).toBe(lua);
        expect(fetcher).toHaveBeenCalledTimes(2);
        const [raw,options]=fetcher.mock.calls[1] as unknown as [URL,RequestInit];
        expect(String(raw)).toBe("https://lua.tools/api/manifest/download?appid=620&source=Luie");
        expect(options.headers).toEqual({Authorization:"Bearer synthetic-luatools"});expect(options.redirect).toBe("manual");
    });
    it("falls through to Hubcap when LuaTools has no result",async()=>{
        vi.mocked(providerAccessToken).mockResolvedValue({token:"synthetic",accountId:"fixture",version:"1"});
        const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(null,{status:404})));vi.stubGlobal("fetch",fetcher);
        await expect(fetchProviderLua({} as Sql,env,620)).rejects.toMatchObject({code:"PROVIDER_CONFIG"});
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each([0,8])("extracts only the matching Lua from ZIP method %s",async method=>{
        expect(new TextDecoder().decode(await readLuaToolsPackage(new Response(zip([{name:"nested/620.lua",text:lua,method},{name:"other.lua",text:'addappid(621, 0, "other")'}])),620))).toBe(lua);
    });
    it("supports a bare Lua and rejects wrong AppID, HTML and ambiguous archives",async()=>{
        expect(new TextDecoder().decode(await readLuaToolsPackage(new Response(lua),620))).toBe(lua);
        for(const bytes of [new TextEncoder().encode('addappid(621, 0, "wrong")'),new TextEncoder().encode('<html>Error</html>'),zip([{name:"a.lua",text:lua},{name:"b.lua",text:lua}]),zip([{name:"../620.lua",text:lua}])])
            await expect(readLuaToolsPackage(new Response(bytes as Uint8Array<ArrayBuffer>),620)).rejects.toThrow();
    });
    it('accepts Luie single-argument main AppID in bare Lua and ZIP without modifying the payload', async () => {
        // Same structure as the reported 3591180 file, with synthetic depot data.
        const content = '-- Main AppID\r\naddappid(3591180)\r\n-- Main Depots\r\naddappid(3591181, 1, "fixture")\r\naddappid(4590370) -- DLC\r\n';
        for (const payload of [new TextEncoder().encode(content), zip([{ name: '3591180.lua', text: content }])]) {
            expect(new TextDecoder().decode(await readLuaToolsPackage(new Response(payload as Uint8Array<ArrayBuffer>), 3591180))).toBe(content);
        }
        const single = 'addappid(3591180)';
        expect(new TextDecoder().decode(await readLua(new Response(single)))).toBe(single);
        expect(new TextDecoder().decode(await readLuaToolsPackage(new Response(single), 3591180))).toBe(single);
    });
    it('requires an exact AppID and an argument delimiter', async () => {
        for (const content of ['addappid(35911801)', 'addappid(359118)', 'addappid(3591180foo)', 'addappid(3591180', 'addappid(3591181, 1, "fixture")']) {
            await expect(readLuaToolsPackage(new Response(content), 3591180)).rejects.toMatchObject({ code: 'PROVIDER_BAD_FILE' });
        }
        expect(new TextDecoder().decode(await readLuaToolsPackage(new Response('addappid( 3591180 )'), 3591180))).toBe('addappid( 3591180 )');
    });
    it("rejects corrupt and oversized decompressed Lua",async()=>{
        expect(luaZipCrc(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
        const bytes=zip([{name:"620.lua",text:lua}]);bytes[14]^=1; // central/local CRC mismatch is validated against output below
        const central=Buffer.from(bytes).indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes[central+16]^=1;
        await expect(readLuaToolsPackage(new Response(bytes as Uint8Array<ArrayBuffer>),620)).rejects.toThrow();
        await expect(readLuaToolsPackage(new Response(zip([{name:"620.lua",text:lua+" ".repeat(1_000_000)}])),620)).rejects.toThrow();
    });
});
