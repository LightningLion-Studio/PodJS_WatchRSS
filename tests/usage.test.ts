import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SCHEMA} from "../src/core/schema.ts";
import {normalizeUsage,readUsage,clearUsage} from "../src/llm/usage.ts";
import type {SqlDatabase} from "../src/core/types.ts";
test("usage supports canonical provider fields and actual camelCase summary responses without losing totals",()=>{
 expect(normalizeUsage({prompt_tokens:12,completion_tokens:4,total_tokens:16,completion_tokens_details:{reasoning_tokens:2}})).toEqual({aggregate:{prompt:12,completion:4,total:16},record:{prompt:12,completion:4,total:16,reasoning:2}});
 expect(normalizeUsage({input_tokens:12,output_tokens:4}).record.total).toBe(16);
 expect(normalizeUsage({input_tokens:12,output_tokens:4}).aggregate.total).toBe(16);
 expect(normalizeUsage({promptTokenCount:9,candidatesTokenCount:2,totalTokenCount:100}).record.total).toBe(100);
 expect(normalizeUsage({totalTokenCount:100}).record.total).toBe(100);
 expect(normalizeUsage({inputTokens:12,outputTokens:4,totalTokens:16}).record.total).toBe(16);
 expect(normalizeUsage({prompt_tokens:0,inputTokens:12,completion_tokens:0,outputTokens:4,total_tokens:0,totalTokens:16}).aggregate).toEqual({prompt:0,completion:0,total:0});
 for(const raw of [null,[],"bad",{total_tokens:-1},{total_tokens:Infinity},{total_tokens:true},{total_tokens:[]}])expect(normalizeUsage(raw).aggregate.total).toBe(0);
});
test("usage pages full history, retains newest 200, groups models and UTC days without changing raw data",async()=>{
 const sql=new Database(":memory:");for(const q of SCHEMA)sql.run(q);
 const queries:string[]=[];const db:SqlDatabase={query:async(q,p=[])=>{queries.push(q);return sql.query(q).all(...p as any[]) as any;},execute:async(q,p=[])=>{sql.run(q,p as any[]);},transaction:async()=>{}};
 const now=100*86400000+1234;
 for(let i=1;i<=305;i++)sql.run("INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES(?,?,?,?,?)",["WatchRSS",i%2?"a":"b",String(i),i===1?"invalid":JSON.stringify({prompt_tokens:2,completion_tokens:3,total_tokens:5}),i===1?now-8*86400000:now-(i%3)*86400000]);
 const before=sql.query("SELECT * FROM llm_token_usage ORDER BY id").all();const result=await readUsage(db,now);
 expect(result.statistics).toEqual({calls:305,prompt:608,completion:912,total:1520});expect(result.recent.length).toBe(200);expect(result.recent[0].id).toBe(303);expect(result.providers.length).toBe(2);expect(result.daily.length).toBe(3);expect(result.daily.reduce((n,d)=>n+d.calls,0)).toBe(304);expect(queries.filter(q=>q.includes("LIMIT 100")).length).toBe(4);expect(sql.query("SELECT * FROM llm_token_usage ORDER BY id").all()).toEqual(before);
 await clearUsage(db);expect((await readUsage(db,now)).statistics.calls).toBe(0);sql.close();
});
