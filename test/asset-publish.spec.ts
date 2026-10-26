import {beforeEach, describe, expect, it, vi} from "vitest";
import {createDb, type Sql} from "../src/lib/db";
import {consumeAssetJob, withAssetPublishConnection} from "../src/lib/asset-jobs";
import {fetchProviderLua} from "../src/lib/asset-providers";
import {uploadR2Lua} from "../src/lib/r2";

vi.mock("../src/lib/db", () => ({createDb:vi.fn()}));
vi.mock("../src/lib/asset-providers", async original => ({...await original<typeof import("../src/lib/asset-providers")>(),fetchProviderLua:vi.fn()}));
vi.mock("../src/lib/r2", () => ({uploadR2Lua:vi.fn()}));
const env={ASSET_MASTER_KEY_HEX:"11".repeat(32)} as Env;
const closed=()=>Object.assign(new Error("synthetic connection close"),{code:"CONNECTION_CLOSED"});
const client=()=>({end:vi.fn().mockResolvedValue(undefined)}) as unknown as Sql;
beforeEach(()=>vi.resetAllMocks());

describe("asset publish connection",()=>{
 it("retries transport failure on a fresh client and closes both",async()=>{
  const first=client(),second=client();vi.mocked(createDb).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const publish=vi.fn().mockRejectedValueOnce(closed()).mockResolvedValueOnce("ready");
  expect(await withAssetPublishConnection(env,publish)).toBe("ready");
  expect(publish.mock.calls.map(([sql])=>sql)).toEqual([first,second]);expect(first.end).toHaveBeenCalledOnce();expect(second.end).toHaveBeenCalledOnce();
 });
 it("stops after two transport failures",async()=>{
  vi.mocked(createDb).mockImplementation(()=>client());const publish=vi.fn().mockRejectedValue(closed());
  await expect(withAssetPublishConnection(env,publish)).rejects.toMatchObject({code:"CONNECTION_CLOSED"});expect(publish).toHaveBeenCalledTimes(2);
 });
 it.each(["23505","23503","57014","40P01"])("does not retry SQL/constraint/timeout error %s",async code=>{
  vi.mocked(createDb).mockReturnValue(client());const publish=vi.fn().mockRejectedValue(Object.assign(new Error("synthetic"),{code}));
  await expect(withAssetPublishConnection(env,publish)).rejects.toMatchObject({code});expect(publish).toHaveBeenCalledOnce();
 });
 it("does not mask a committed result with a cleanup failure",async()=>{
  const sql=client();vi.mocked(sql.end).mockRejectedValue(new Error("closed"));vi.mocked(createDb).mockReturnValue(sql);
  expect(await withAssetPublishConnection(env,async()=>"ready")).toBe("ready");
 });
});

describe("asset job publication recovery",()=>{
 it.each(["write_closed","commit_closed","lease_lost"])("preserves downloaded bytes and lease safety: %s",async scenario=>{
  let committed=false;let inserts=0;let transactions=0;
  const query=vi.fn(async(strings:TemplateStringsArray)=>strings.join("?").includes("returning game_id")?[{game_id:1222670}]:[]);
  const initial=Object.assign(query,{end:vi.fn().mockResolvedValue(undefined)}) as unknown as Sql;
  const publisher=()=>Object.assign(()=>{}, {end:vi.fn().mockResolvedValue(undefined),begin:vi.fn(async(operation:(tx:unknown)=>unknown)=>{
   const attempt=++transactions;
   const tx=vi.fn(async(strings:TemplateStringsArray)=>{
    const text=strings.join("?");
    if(text.includes("for update"))return committed || scenario === "lease_lost" ? []:[{game_id:1222670}];
    if(text.includes("insert into game_assets")){inserts++;if(scenario === "write_closed" && attempt === 1)throw closed();}
    return [];
   });
   await operation(tx);committed=true;if(scenario === "commit_closed" && attempt === 1)throw closed();
  })}) as unknown as Sql;
  vi.mocked(createDb).mockReturnValueOnce(initial).mockImplementation(publisher);
  vi.mocked(fetchProviderLua).mockResolvedValue({bytes:new TextEncoder().encode("addappid(1222670)"),source:"fixture"});
  vi.mocked(uploadR2Lua).mockResolvedValue(undefined);
  expect(await consumeAssetJob({gameId:1222670,requestToken:"fixture"},env)).toBe("done");
  expect(fetchProviderLua).toHaveBeenCalledOnce();expect(uploadR2Lua).toHaveBeenCalledOnce();
  expect(inserts).toBe(scenario === "write_closed"?2:scenario === "commit_closed"?1:0);
  expect(transactions).toBe(scenario === "lease_lost"?1:2);
 });
});
