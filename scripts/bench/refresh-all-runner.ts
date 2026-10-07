import {kv} from "@podjs/framework/watch";
import {writeHomeChannelSnapshot} from "../../src/ui/home-snapshot.ts";
import {WatchRssRepository} from '../../src/core/repository.ts';
import {sqlite} from '@podjs/framework/services';
import {__setServiceTraceEnabled} from '@podjs/framework/service-trace';
const g=globalThis as any,fixture=g.__refreshFixture,now=g.__benchNow,print=g.__benchPrint;
let index=0;const pending:any[]=[],events:any[]=[],spans:any[]=[],turns:any[]=[];
Date.now=()=>fixture.fixed+Math.floor(now());
Object.assign(g.pod,{capabilities:()=>JSON.stringify(['data.sqlite','runtime.timer']),emit:(line:string)=>{const r=JSON.parse(line);if(r.t==='service.request')pending.push(r);else if(r.t==='diagnostic.serviceWork')spans.push(r);},takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined});
__setServiceTraceEnabled(true);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const init=async()=>{},db=sqlite;
const repo=new WatchRssRepository(db,async url=>new Promise<string>(resolve=>pending.push({method:'fixture.fetch',url,resolve})));
async function refreshChannel(id:string){await repo.refreshChannel(Number(id));await listChannels();}
/* PRODUCTION_FUNCTIONS */
g.__benchPump=()=>{
 if(!pending.length)return false;const request=pending.shift(),began=now();
 if(request.method==='runtime.delay'){events.push({t:'service.result',id:request.id,ok:true,value:null});g.__pocketPumpServices();return true;}
 const reply=fixture.replies[index++];if(!reply||reply.method!==request.method)throw Error('reply method differential '+index);
 // Times are fixed for byte-exact SQL differential, without logging content.
 if(request.method==='fixture.fetch'){if(reply.url!==request.url)throw Error('fetch sequence');request.resolve(reply.value);}
 else {const args=request.args;const expected=request.method==='sql.query'?{sql:reply.sql,params:reply.params}:{statements:reply.statements};const actual=request.method==='sql.query'?{sql:args.sql,params:args.params}:{statements:args.statements};
 const normalize=(v:any)=>JSON.stringify(v).replace(/175000000\d{4}/g,'1750000000000');if(normalize(expected)!==normalize(actual))throw Error('SQL statement differential '+index);
 events.push({t:'service.result',id:request.id,ok:true,value:reply.value});g.__pocketPumpServices();}
 turns.push({method:request.method,rows:Array.isArray(reply.value)?reply.value.length:-1,bytes:JSON.stringify(reply.value).length,pumpMs:now()-began});return true;
};
// Baseline fixed clock during semantic replay; duration spans need wall clock.
refresh().then(async()=>{const result=await listChannels();let snapshotMs:number|undefined;if(typeof g.pod.kvSet==='function'){const began=now();writeHomeChannelSnapshot(kv,result);snapshotMs=now()-began;if(JSON.stringify(canonical(kv.get('watchrss.home.channels.v1')))!==JSON.stringify(canonical(result)))throw Error('KV snapshot differential');}const strip=(v:any)=>JSON.stringify(v).replace(/175000000\d{4}/g,'1750000000000');if(strip(result)!==strip(fixture.expected)||index!==fixture.replies.length)throw Error('final channel differential');print(JSON.stringify({phase:'refresh-all',equal:true,snapshotMs,callbacks:turns,spans,sizes:fixture.sizes,note:'Real production refresh loop/repository/SQL; reconstructed XML from real snapshot; SQL worker/network/UI/GPU timing synthetic or absent; optional KV uses real Rust locked/fsync store on host storage.'}));g.__benchDone=true;}).catch((error:any)=>{print(String(error));throw error;});
