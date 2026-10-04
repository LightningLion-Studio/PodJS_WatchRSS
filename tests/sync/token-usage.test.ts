import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {SCHEMA} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {parseWireJson} from '../../src/sync/wire-json.ts';
import {tokenUsageWireFields,readTokenUsageForSync} from '../../src/sync/token-usage.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import fixture from '../fixtures/token-usage-native.json';
test('token export matches native Kotlin normalizer with Android JSON numeric conversions',()=>{
 for(const row of fixture.cases)expect(tokenUsageWireFields(parseWireJson(row.raw))).toEqual(row.expected);
});
test('token history preserves native limit/order, pages ties and remains read only',async()=>{
 const sql=new Database(':memory:');for(const q of SCHEMA)sql.run(q);
 const queries:string[]=[];let insertDuringRead=false;
 const db:SqlDatabase={query:async(q,p=[])=>{queries.push(q);const result=sql.query(q).all(...p as any[]) as any;if(insertDuringRead&&q.includes('MAX(id)'))sql.run("INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES('late','late','late','{}',999999)");return result;},execute:async()=>{throw Error('read only');},transaction:async()=>{throw Error('read only');}};
 for(let i=1;i<=305;i++)sql.run('INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES(?,?,?,?,?)',['p','m',String(i),i===1?'bad':'{"input_tokens":2,"output_tokens":3}',Math.floor(i/110)]);
 const before=sql.query('SELECT * FROM llm_token_usage ORDER BY id').all();
 expect(await readTokenUsageForSync(db,0)).toEqual([]);expect(queries).toEqual([]);
 const expected=sql.query('SELECT id FROM llm_token_usage ORDER BY created_at DESC,id ASC').all().map((r:any)=>r.id);
 const all=await readTokenUsageForSync(db,-1);expect(all.map(r=>r.id)).toEqual(expected);expect(all).toHaveLength(305);
 expect(all.find(r=>r.id===1)).toEqual({id:1,provider:'p',model:'m',requestId:'1',createdAt:0});
 expect(all[0]).toEqual({id:220,provider:'p',model:'m',requestId:'220',createdAt:2,inputTokens:2,outputTokens:3});
 expect((await readTokenUsageForSync(db,200)).map(r=>r.id)).toEqual(expected.slice(0,200));expect(sql.query('SELECT * FROM llm_token_usage ORDER BY id').all()).toEqual(before);
 insertDuringRead=true;expect((await readTokenUsageForSync(db,-1)).map(r=>r.id)).toEqual(expected);sql.close();
});
test('shared application dispatcher exports token records and handles native default/string/negative limits',async()=>{
 const limits:number[]=[];const records=[{id:1,provider:'p',model:'m',requestId:'r',createdAt:4}];let changed=0;
 const handler=createApplicationActionHandler({notes:{} as any,deviceId:async()=>'',notesChanged:()=>changed++,readTokenUsage:async limit=>{limits.push(limit);return records;}});
 for(const limit of ['',',"limit":"3.9"',',"limit":-1',',"limit":0',',"limit":9007199254740993',',"limit":null'])expect(await handler(parseWireJson('{"action":"syncLlmTokenUsage"'+limit+'}'))).toEqual({success:true,action:'syncLlmTokenUsage',count:1,records});
 expect(limits).toEqual([200,3,-1,0,1,200]);expect(changed).toBe(0);
});
