import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {SummarySession,summaryDisplayText,summarySourceText,summaryTokenUsageText,type SummaryState,type SummaryDependencies} from "../src/llm/summary.ts";
import {loadSummarySource} from "../src/llm/source.ts";
import {SCHEMA} from "../src/core/schema.ts";
import {utf8Encode,utf8Decode,type HttpRequest} from "../src/cloud/types.ts";
import type {WatchAccountState} from "../src/account/types.ts";
import {watchAppVersion} from '../src/core/app-version.ts';
const account={userId:"fixture",watchDeviceToken:"access",backendBaseUrl:"https://summary.test/"} as WatchAccountState;
const reply=(status:number,data:unknown)=>({status,headers:{},body:utf8Encode(JSON.stringify(data))});
function fixture(overrides:Partial<SummaryDependencies>={},preset=()=>1){
 const states:SummaryState[]=[],requests:HttpRequest[]=[],refreshes:boolean[]=[],usage:unknown[]=[];
 const deps:SummaryDependencies={source:async()=>({title:"标题",content:"<p>原文 &amp; 摘要</p>",contentHash:"a".repeat(64)}),account:async()=>account,freshAccount:async(a,force)=>{refreshes.push(force);return {...a,watchDeviceToken:force?"refreshed":a.watchDeviceToken};},transport:{request:async r=>{requests.push(r);return reply(200,{text:"总结结果",model:"m",usage:{inputTokens:12,outputTokens:4,totalTokens:16}});}},recordUsage:async(m,u)=>{usage.push({m,u});},...overrides};
 return {session:new SummarySession(deps,preset,s=>states.push(s)),states,requests,refreshes,usage};
}
test("summary sends bounded native input and preset, persists usage and reuses done result",async()=>{
 const f=fixture({},()=>3);await f.session.start();await f.session.start();expect(f.requests).toHaveLength(1);
 const r=f.requests[0];expect(r.url).toBe("https://summary.test/api/v1/llm/default-model/article-summary");expect(r.headers.Authorization).toBe("Bearer access");expect(r.headers['X-WatchRSS-App-Version']).toBe(watchAppVersion);expect(JSON.parse(utf8Decode(r.body!))).toEqual({title:"标题",content:"原文 & 摘要",contentHash:"a".repeat(64),promptPreset:3,stream:false});expect(f.session.state).toEqual({status:"done",text:"总结结果",inputTokens:12,outputTokens:4,totalTokens:16});expect(f.usage).toHaveLength(1);
});
test("summary presentation keeps the full error visible and gates per-request token usage",()=>{
 const error:SummaryState={status:"error",text:"",error:"后端暂不可用"};
 expect(summaryDisplayText(error)).toBe("生成失败\n后端暂不可用\n点击重试");
 expect(summaryDisplayText({status:"error",text:""})).toBe("生成失败\n未知错误\n点击重试");
 const done:SummaryState={status:"done",text:"总结",inputTokens:12,outputTokens:4,totalTokens:16};
 expect(summaryTokenUsageText(done,false)).toBeNull();
 expect(summaryTokenUsageText(done,true)).toBe("输入 12 · 输出 4 · 合计 16");
 expect(summaryTokenUsageText({...done,totalTokens:undefined},true)).toBeNull();
 expect(summaryTokenUsageText({status:"done",text:"总结",totalTokens:16},true)).toBe("合计 16");
});
test("summary refreshes once for 401 or 403 and reports exhausted authorization",async()=>{
 for(const code of [401,403]){let calls=0;const auth:string[]=[];const f=fixture({transport:{request:async r=>{auth.push(r.headers.Authorization);return ++calls===1?reply(code,{}):reply(200,{text:"刷新后"});}}});await f.session.start();expect(f.refreshes).toEqual([false,true]);expect(auth).toEqual(["Bearer access","Bearer refreshed"]);expect(f.session.state.text).toBe("刷新后");}
 let count=0;const f=fixture({transport:{request:async()=>{count++;return reply(401,{});}}});await f.session.start();expect(count).toBe(2);expect(f.session.state.error).toBe("账号授权已失效，请从手机重新同步");
});
test("summary account gates do not issue network calls; errors can retry",async()=>{
 let logged=false;const f=fixture({account:async()=>logged?account:null});await f.session.start();expect(f.session.state.error).toBe("请先从已授权手机同步账号");expect(f.requests).toHaveLength(0);logged=true;await f.session.start();expect(f.session.state.status).toBe("done");
 const blank=fixture({account:async()=>({...account,backendBaseUrl:" "})});await blank.session.start();expect(blank.session.state.error).toBe("账号后端地址未配置");expect(blank.requests).toHaveLength(0);
});
test("summary reports paid requirement, backend detail and malformed responses",async()=>{
 for(const [response,message] of [[reply(402,{}),"AI 总结仅限已购买 6 元授权的用户"],[reply(500,{detail:"后端暂不可用"}),"后端暂不可用"],[reply(500,{error:"服务忙"}),"服务忙"],[reply(200,[]),"总结响应格式错误"]] as const){const f=fixture({transport:{request:async()=>response}});await f.session.start();expect(f.session.state.error).toBe(message);expect(f.usage).toHaveLength(0);}
});
test("waiting content is replaced before sending; overlapping start is coalesced",async()=>{
 let resolve!:(s:{title:string;content:string})=>void;const f=fixture({source:waiting=>{waiting();return new Promise(r=>resolve=r);}});const pending=f.session.start();expect(f.session.state.status).toBe("waiting");expect(f.session.start()).toBe(pending);expect(f.requests).toHaveLength(0);resolve({title:"已加载",content:"原文"});await pending;expect(JSON.parse(utf8Decode(f.requests[0].body!)).content).toBe("原文");
});
test("disposed summaries cancel transport and ignore late responses and usage",async()=>{
 let resolve!:(r:ReturnType<typeof reply>)=>void,cancelled=0;const f=fixture({transport:{request:()=>new Promise(r=>resolve=r)},cancel:()=>cancelled++});const pending=f.session.start();for(let i=0;i<6;i++)await Promise.resolve();f.session.dispose();const before=f.states.length;resolve(reply(200,{text:"已离开文章"}));await pending;expect(cancelled).toBe(1);expect(f.states.length).toBe(before);expect(f.usage).toHaveLength(0);
});
test("usage recording failures do not discard a successful summary; invalid presets fall back",async()=>{
 const f=fixture({source:async()=>({title:"t",content:"",contentHash:"bad"}),recordUsage:async()=>{throw new Error("disk");}},()=>8);await f.session.start();const body=JSON.parse(utf8Decode(f.requests[0].body!));expect(body).toEqual({title:"t",content:"",promptPreset:1,stream:false});expect(f.session.state.status).toBe("done");
});
test("native summary source scan is bounded, preserves plain markup, collapses whitespace",()=>{
 expect(summarySourceText(" <p>A&nbsp;B &amp; &#x4e2d; &#25991; &unknown;</p><p>C</p> ")).toBe("A B & 中 文 C");expect(summarySourceText(" a <b>  c ",true)).toBe("a <b> c");expect(summarySourceText("文".repeat(540000)).length).toBe(3000);expect(summarySourceText(" ".repeat(64000)+"after")).toBe("");expect(summarySourceText("<"+"x".repeat(64000)+">after")).toBe("");
});
test("summary database source prefers cached original independent of reader mode and protects saved rows",async()=>{
 const sql=new Database(":memory:");for(const query of SCHEMA)sql.run(query);
 sql.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test','频道',1)");sql.run("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_saved) VALUES(1,1,'原文标题','RSS内容','https://a.test','a',1,1)");
 const db={query:async(q:string,p:unknown[]=[])=>sql.query(q).all(...p as any[]) as Record<string,unknown>[],execute:async(q:string,p:unknown[]=[])=>{sql.run(q,p as any[]);},transaction:async()=>{}};
 let fetched=0;const load=()=>loadSummarySource(db,"1",async()=>{fetched++;},()=>{throw new Error("unexpected wait");});
 expect((await load()).content).toBe("RSS内容");sql.run("INSERT INTO article_original_chunks VALUES(1,0,'原文内容')");expect((await load()).content).toBe("原文内容");expect(fetched).toBe(0);expect(sql.query("SELECT is_saved FROM articles").get()).toEqual({is_saved:1});
 sql.run("DELETE FROM article_original_chunks");sql.run("UPDATE articles SET content=NULL");sql.run("INSERT INTO article_body_chunks VALUES(1,0,?)",["书".repeat(64000)]);sql.run("INSERT INTO article_body_chunks VALUES(1,1,'不应读取')");expect((await load()).content).toBe("书".repeat(64000));
 sql.run("UPDATE articles SET link='https://watchrss.local/import-content/web/1'");expect((await load()).plainText).toBe(false);sql.run("UPDATE articles SET link='https://watchrss.local/import-content/txt/1'");expect((await load()).plainText).toBe(true);sql.close();
});
test("empty original-mode article waits for fetched content without writing RSS or saved state",async()=>{
 const sql=new Database(":memory:");for(const q of SCHEMA)sql.run(q);sql.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test','频道',1)");sql.run("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_saved) VALUES(1,1,'标题','','https://a.test','a',1,1)");sql.run("INSERT INTO source_preferences(channel_id,use_original_content) VALUES(1,1)");
 const db={query:async(q:string,p:unknown[]=[])=>sql.query(q).all(...p as any[]) as Record<string,unknown>[],execute:async()=>{},transaction:async()=>{}};let waiting=0;const source=await loadSummarySource(db,"1",async()=>{sql.run("INSERT INTO article_original_chunks VALUES(1,0,'等待后的原文')");},()=>waiting++);expect(waiting).toBe(1);expect(source.content).toBe("等待后的原文");expect(sql.query("SELECT content,is_saved FROM articles").get()).toEqual({content:"",is_saved:1});sql.close();
});
