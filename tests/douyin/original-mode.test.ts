import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {DOUYIN_ORIGINAL_MODE_KEY,douyinOriginalContentEnabled,migrateDouyinOriginalMode} from "../../src/douyin/original-mode.ts";
import type {SqlDatabase} from "../../src/core/types.ts";

function fixture(channel=true,explicit?:boolean,legacy?:unknown){
  const sql=new Database(":memory:");
  sql.exec("CREATE TABLE channels(id INTEGER PRIMARY KEY,url TEXT);CREATE TABLE source_preferences(channel_id INTEGER PRIMARY KEY,use_original_content INTEGER,read_preset TEXT DEFAULT 'default')");
  if(channel)sql.run("INSERT INTO channels VALUES(1,'builtin:douyin')");
  if(explicit!==undefined)sql.run("INSERT INTO source_preferences VALUES(1,?,'custom')",[Number(explicit)]);
  const values=new Map<string,unknown>();if(legacy!==undefined)values.set(DOUYIN_ORIGINAL_MODE_KEY,legacy);
  const store={get:<T>(key:string)=>values.get(key) as T|undefined,delete:(key:string)=>{values.delete(key);}};
  const db={execute:async(q:string,p:unknown[]=[])=>{sql.run(q,p as (string|number|null)[]);}} as SqlDatabase;
  return {sql,db,store,values,read:()=>sql.query("SELECT * FROM source_preferences").all()};
}
test("Douyin defaults true and respects explicit false",()=>{
  expect(douyinOriginalContentEnabled()).toBe(true);expect(douyinOriginalContentEnabled({})).toBe(true);
  expect(douyinOriginalContentEnabled({useOriginalContent:false})).toBe(false);
});
for(const legacy of [true,false])test(`migrates legacy ${legacy} once, then channel wins`,async()=>{
  const f=fixture(true,undefined,legacy);
  try{await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toMatchObject([{use_original_content:Number(legacy)}]);expect(f.values.has(DOUYIN_ORIGINAL_MODE_KEY)).toBe(false);
    f.sql.run("UPDATE source_preferences SET use_original_content=?",[Number(!legacy)]);
    await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toMatchObject([{use_original_content:Number(!legacy)}]);
  }finally{f.sql.close();}
});
for(const explicit of [true,false])test(`existing channel ${explicit} overrides opposite KV and keeps preset`,async()=>{
  const f=fixture(true,explicit,!explicit);try{await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toMatchObject([{use_original_content:Number(explicit),read_preset:"custom"}]);expect(f.values.size).toBe(0);}finally{f.sql.close();}
});
test("missing or invalid KV defaults true; deleted channel stays deleted",async()=>{
  for(const legacy of [undefined,"false"]){const f=fixture(true,undefined,legacy);try{await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toMatchObject([{use_original_content:1}]);}finally{f.sql.close();}}
  const f=fixture(false,undefined,false);try{await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toEqual([]);expect(f.values.size).toBe(0);}finally{f.sql.close();}
});
test("failed database migration preserves KV for next startup",async()=>{
  const f=fixture(true,undefined,false);try{await expect(migrateDouyinOriginalMode({execute:async()=>{throw Error("locked");}} as unknown as SqlDatabase,f.store)).rejects.toThrow("locked");expect(f.values.get(DOUYIN_ORIGINAL_MODE_KEY)).toBe(false);await migrateDouyinOriginalMode(f.db,f.store);expect(f.read()).toMatchObject([{use_original_content:0}]);}finally{f.sql.close();}
});
