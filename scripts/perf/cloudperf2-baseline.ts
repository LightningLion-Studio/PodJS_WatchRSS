/** Synthetic production-function profile in the actual headless QuickJS VM.
 * No network, account, durable receipt, or book-readiness assertion. */
import {canonical} from '../../src/cloud/records';
import {ARTICLE_REGISTER_FEATURE,ARTICLE_REGISTERS,mergeArticleRegisters} from '../../src/cloud/article-register';
import {parseRawJson,patchRawJsonObject,jsonUtf8Bytes} from '@podjs/framework/json-raw';
import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
const root=globalThis as any;
root.backgroundHandler=async(ctx:any)=>{
 if(ctx.payload?.native===false){root.__podByteCodecs.rawJsonScan=undefined;root.__podByteCodecs.strictUtf8ByteLength=undefined;}
 let calls=0;const native=root.__podByteCodecs.rawJsonScan;
 if(native)root.__podByteCodecs.rawJsonScan=(...args:any[])=>{calls++;return native(...args);};
 const phase=async<T>(stage:string,bytes:number,items:number,fn:()=>T|Promise<T>)=>{
  await ctx.request('perf',{event:'start',stage,bytes,items});
  const result=await fn();await ctx.request('perf',{event:'end',stage,bytes,items});return result;
 };
 await phase('json-differential',0,1010,()=>{
  const counter=root.__podByteCodecs.strictUtf8ByteLength;
  for(const text of ['','中😀','x'.repeat(65535)+'😀'+'中'.repeat(70000),'x'.repeat(100)+'\ud800','\ufeff\u0000']){
   const count=()=>{try{return jsonUtf8Bytes(text);}catch(error){return String(error);}};
   const accelerated=count();root.__podByteCodecs.strictUtf8ByteLength=undefined;const portable=count();root.__podByteCodecs.strictUtf8ByteLength=counter;
   if(accelerated!==portable)throw Error('utf8_count_diff');
  }
  const fixtures=['{"wide":9007199254740993,"s":"\\u4e2d","😀":[-0,1e9999,true,null]}','{"a":1,"\\u0061":2}','"\\ud800"','"\udfff"','[1,]','{"x":01}','{"x":true garbage}','"\\u+123"','"\\ud800\\u+123"','['.repeat(33)+'0'+']'.repeat(33)];
  for(let i=0;i<1000;i++)fixtures.push(JSON.stringify({['k'+i]:{str:'中😀\\\"\n'.repeat(i%17),items:[i,i/100,-i,true,null]},__proto__:null,future:'x'.repeat(i%100)}));
  for(const text of fixtures){const capture=(native:boolean)=>{const hostPatch=root.__podByteCodecs.patchRawJsonObject;if(!native)root.__podByteCodecs.patchRawJsonObject=undefined;try{const node=parseRawJson(text,{native});return JSON.stringify(node)+'|'+(node.kind==='object'?patchRawJsonObject(node,{changed:'9007199254740993'}):'');}catch(error){return String(error);}finally{root.__podByteCodecs.patchRawJsonObject=hostPatch;}};if(capture(false)!==capture(true))throw Error('native_json_differential');}
 });
 for(const size of [0.25,1,5,20].map(n=>n*1048576)){
  const raw=JSON.stringify({body:'x'.repeat(size-32),version:1});
  const value=await phase('json-parse',raw.length,1,()=>JSON.parse(raw));
  await phase('json-stringify',raw.length,1,()=>{if(JSON.stringify(value)!==raw)throw Error('json_roundtrip');});
  await phase('canonical-json',raw.length,1,()=>{if(canonical(value)!==raw)throw Error('canonical_diff');});
  await phase('json-scan',raw.length,1,()=>{if(parseRawJson(raw,{maxBytes:32*1048576}).end!==raw.length)throw Error('scan_diff');});
 }
 const sources=Object.fromEntries(ARTICLE_REGISTERS.map(r=>[r,'synthetic']));
 const records=Array.from({length:512},(_,i)=>({kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]},value:{articleId:'article-'+i,url:'https://example.invalid/'+i,contentHash:'',updatedAt:1,sourceDeviceId:'synthetic',registerSources:sources,title:'title '+i,excerpt:'x'.repeat(512)}}));
 await phase('record-merge',JSON.stringify(records).length,records.length,()=>{
  for(const record of records){const next={...record,value:{...record.value,updatedAt:2,title:'updated'}};const merged=mergeArticleRegisters(record,next);if(merged.conflict||merged.doc.value.title!=='updated')throw Error('merge_diff');}
 });
 const files=new Map<string,string>();const journal=new JsonDeltaJournal({read:async p=>files.get(p),replace:async(p,t)=>{files.set(p,t);},append:async(p,t,offset)=>{const old=files.get(p)??'';if(old.length!==offset)throw Error('offset');files.set(p,old+t);}},'fixture',['rows']);
 const rows=Object.fromEntries(records.map((r,i)=>[String(i),r]));await journal.load();await journal.commit({rows});
 await phase('journal-diff',JSON.stringify(rows).length,records.length,async()=>{const result=await journal.commit({rows:{...rows}});if(result.edits!==0)throw Error('unchanged_journal');});
 await phase('native-scan-calls',0,calls,()=>{});
 return 'success';
};
