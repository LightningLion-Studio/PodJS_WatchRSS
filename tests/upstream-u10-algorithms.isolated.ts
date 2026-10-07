import {expect,test} from 'bun:test';
import {oracle} from './upstream-u10-loader.ts';
import * as gate from '../src/debug/gate.ts';
import * as volume from '../src/media/crown-volume.ts';
import * as exit from '../src/navigation/reader-exit.ts';
import * as preview from '../src/reader/preview-session.ts';
import * as search from '../src/rss/search-snippet.ts';
import {defaultReaderPreset} from '../src/reader/preset.ts';
const oldGate=await oracle('debug/gate.ts'),oldVolume=await oracle('media/crown-volume.ts'),oldExit=await oracle('navigation/reader-exit.ts'),oldPreview=await oracle('reader/preview-session.ts'),oldSearch=await oracle('rss/search-snippet.ts');
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function attempt(fn:()=>unknown){try{return {value:fn()};}catch(error){return {error:{name:(error as Error).name,message:(error as Error).message}};}}
async function outcome(fn:()=>unknown){try{return {value:await fn()};}catch(error){return {error:{name:(error as Error).name,message:(error as Error).message}};}}
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(v:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fakeClock(){let time=1000,id=0;const jobs=new Map<number,{at:number;run:()=>void}>(),events:any[]=[];
 const clock={now:()=>time+10000,monotonic:()=>time,after(ms:number,run:()=>void){const key=++id;events.push(['after',ms,key]);jobs.set(key,{at:time+ms,run});return()=>{events.push(['cancel',key]);jobs.delete(key);};}};
 return {clock,jobs,events,tick(ms:number){const end=time+ms;while(true){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;jobs.delete(next[0]);events.push(['fire',next[0]]);next[1].run();}time=end;}};
}
test('gate is closed before/while init, shares promise, resolves only literal debug flag and never retries failure',async()=>{
 for(const value of [undefined,null,{},true,{debugBuild:false},{debugBuild:1},{debugBuild:'true'},{debugBuild:true}]){
  async function run(api:any){const g=new api.DebugGate(),d=deferred<unknown>();let reads=0;const states=[g.allowed,attempt(()=>g.require())];const first=g.initialize(()=>{reads++;return d.promise;}),second=g.initialize(async()=>({debugBuild:true}));states.push(first===second,g.allowed);await settle();states.push(reads,g.allowed);d.resolve(value);states.push(await first,await second,g.allowed,attempt(()=>g.require()),await g.initialize(async()=>({debugBuild:true})));return states;}
  expect(await run(gate)).toEqual(await run(oldGate));
 }
 for(const sync of [false,true]){
  async function run(api:any){const g=new api.DebugGate();const value=await g.initialize(()=>{if(sync)throw Error('read');return Promise.reject(Error('read'));});return [value,g.allowed,await g.initialize(async()=>({debugBuild:true})),attempt(()=>g.require())];}
  expect(await run(gate)).toEqual(await run(oldGate));
 }
});
test('Float guard, session-gap edges and fractional motion match oracle through deterministic trajectories',()=>{
 let seed=0x987612;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(const [min,max] of [[0,0],[2,1],[0,15],[2,31],[1,100]]){
  let a=volume.emptyCrownGuard(),b=oldVolume.emptyCrownGuard(),current=min,time=1000;
  for(let i=0;i<800;i++){
   const raw=[0,-1,1,-1000,1000,(rand()%1000-500)/7][rand()%6],delta=volume.scaledCrownVolumeDelta(raw,min,max);
   expect(delta).toBe(oldVolume.scaledCrownVolumeDelta(raw,min,max));time+=[0,599,600,601,-20][rand()%5];const enabled=!!(rand()%2);
   const x=volume.applyCrownVolumeGuard(current,delta,min,max,enabled,a,time),y=oldVolume.applyCrownVolumeGuard(current,delta,min,max,enabled,b,time);
   expect(x).toEqual(y);a=x.state;b=y.state;current=x.target;
  }
 }
});
test('crown batching, reset during state/write, external changes, fixed volume, failures and hide events preserve event order',async()=>{
 for(const scenario of ['normal','reset-state','reset-write','state-error','write-error','fixed','external']){
  async function run(api:any){const c=fakeClock(),events:any[]=[],read=deferred<any>(),write=deferred<any>();let count=0;let state={min:0,max:15,current:0,fixed:scenario==='fixed'};
   const port={async state(){events.push(['read',++count]);if(count===1)return read.promise;return {...state};},async setIndex(index:number){events.push(['write',index]);state={...state,current:index};if(count===1)return write.promise;return {...state};}};
   // Production wrapper uses the default failed callback in the normal/fixed case.
   const args=[port,c.clock,(v:any)=>events.push(['display',v]),()=>events.push(['notify'])];if(scenario!=='normal'&&scenario!=='fixed')args.push((e:any)=>events.push(['error',e.message]));
   const v=new api.CrownVolumeController(...args);v.adjust(NaN,0,true);v.adjust(0,0,true);v.adjust(-30,NaN,true);v.adjust(-500,1000,true);v.adjust(-300,1100,true);
   if(scenario==='reset-state')v.reset();
   if(scenario==='state-error')read.reject(Error('read'));else read.resolve({...state});await settle();
   if(scenario==='reset-write')v.reset();v.adjust(100,1900,false);v.adjust(-25,2501,true);
   if(scenario==='write-error')write.reject(Error('write'));else write.resolve({...state});await settle();
   if(scenario==='external')state={...state,current:10};v.adjust(-25,3102,true);await settle();c.tick(1199);c.tick(1);v.reset();c.tick(1200);await settle();return {events,timers:c.events,left:c.jobs.size};
  }
  expect(await run(volume)).toEqual(await run(oldVolume));
 }
});
test('bounded flush timer creation/cancellation and saved/failed/timed-out races match original',async()=>{
 for(const mode of ['saved','write-reject','write-throw','timer-reject','timer-throw','timeout','both']){
  async function run(api:any){const events:any[]=[],w=deferred<void>(),t=deferred<void>();const err=Error('fixture');
   const waiting=api.waitForReaderProgressFlush(()=>{events.push('flush');if(mode==='write-throw')throw err;return w.promise;},(ms:number)=>{events.push(['timer',ms]);if(mode==='timer-throw')throw err;return {result:t.promise,cancel:()=>events.push('cancel')};});
   if(mode==='saved'||mode==='both')w.resolve();if(mode==='write-reject')w.reject(err);if(mode==='timeout'||mode==='both')t.resolve();if(mode==='timer-reject')t.reject(err);
   const result=await waiting;w.resolve();t.resolve();await settle();return {events,result};
  }
  expect(await run(exit)).toEqual(await run(oldExit));
 }
});
test('exit guard dedupes by target identity and old completion cannot clear a newer attempt',async()=>{
 async function run(api:any){const events:any[]=[],timers:any[]=[],writes:any[]=[];const a={},b={};const g=new api.ReaderExitGuard((ms:number)=>{const t=deferred<void>();timers.push(t);events.push(['timer',ms]);return {result:t.promise,cancel:()=>events.push('cancel')};});
  const begin=(target:object,label:string)=>g.begin(target,()=>{events.push(['flush',label]);const d=deferred<void>();writes.push(d);return d.promise;},(v:any)=>events.push(['complete',label,v]));
  begin(a,'a');begin(a,'duplicate');begin(b,'b');writes[0].resolve();await settle();begin(b,'duplicate-b');begin(a,'a2');timers[1].resolve();await settle();begin(a,'duplicate-a2');writes[2].reject(Error('write'));await settle();begin(a,'a3');writes[3].resolve();await settle();return events;
 }
 expect(await run(exit)).toEqual(await run(oldExit));
});
test('preview full/delta validation, sequence consumption, coalescing, heartbeat and expiry match frozen frames and timers',()=>{
 for(const interval of [0,33,100]){
  function run(api:any){const c=fakeClock(),s=new api.ReaderPreviewSession(c.clock,20000,interval),states:any[]=[],results:any[]=[];const unsub=s.subscribe((state:any)=>states.push(structuredClone(state)));const base=defaultReaderPreset('p','base');
   const act=(fn:()=>unknown)=>{results.push(attempt(fn));results.push(structuredClone(s.state()));};
   act(()=>s.update('',0,base));act(()=>s.update('s',-1,base));act(()=>s.update('s',0,base,true));act(()=>s.update('s',0,{...base,name:'duplicate'}));
   act(()=>s.updateDelta('s',1,{body:null}));act(()=>s.updateDelta('s',1,{name:'ignored'}));act(()=>s.heartbeat('s',0));
   act(()=>s.updateDelta('s',2,{name:'a'}));act(()=>s.updateDelta('s',3,{body:{fontSizeSp:21}},true));act(()=>s.refreshResourceTransfer());c.tick(32);act(()=>s.state());c.tick(1);act(()=>s.refreshResourceTransfer());
   act(()=>s.updateDelta('s',4,{},true));act(()=>s.heartbeat('other',100));act(()=>s.heartbeat('s',10));act(()=>s.updateDelta('s',10,{name:'stale'}));
   act(()=>s.update('b',0,{...base,name:'b'}));act(()=>s.stop('s'));act(()=>s.updateDelta('s',20,{}));c.tick(20000);act(()=>s.state());
   act(()=>s.update('b',0,base,true));c.tick(110000);act(()=>s.refreshResourceTransfer());c.tick(110000);act(()=>s.state());act(()=>s.heartbeat('b',0));c.tick(20000);act(()=>s.state());
   act(()=>s.update('z',0,base));act(()=>s.updateDelta('z',1,{name:'pending'}));unsub();act(()=>s.dispose());c.tick(100);act(()=>s.update('z',2,base));return {states,results,timers:c.events,left:c.jobs.size};
  }
  expect(run(preview)).toEqual(run(oldPreview));
 }
});
test('preview listener removal, reentrant replacement and thrown publish retain original order',()=>{
 for(const mode of ['stop','replace','throw']){
  function run(api:any){const c=fakeClock(),s=new api.ReaderPreviewSession(c.clock),base=defaultReaderPreset(),events:any[]=[];let once=true;
   s.subscribe((state:any)=>{events.push(state?.sessionId??null);if(state&&once){once=false;if(mode==='stop')s.stop(state.sessionId);if(mode==='replace')s.update('next',0,base);if(mode==='throw')throw Error('listener');}});
   const result=attempt(()=>s.update('first',0,base));c.tick(20000);return {events,result,state:s.state(),timers:c.events};
  }
  expect(run(preview)).toEqual(run(oldPreview));
 }
});
test('case folding, UTF-16 indexes, overlapping/whole matches and wrapped geometry equal frozen oracle',()=>{
 const texts=['','AaAa','İIıi','😀中文😀中','Straße STRASSE','repeat repeat\r\nrepeat','ab\rbc\ncd','a\tb &amp; <tag>c','abc abcdef'];
 for(const text of texts)for(const query of ['',' ','a','aa','i','😀','中','\nb','bc','repeat',' abc ']){
  expect(search.searchHighlights(text,query)).toEqual(oldSearch.searchHighlights(text,query));
  const measured:string[]=[],measure=(v:string)=>{measured.push(v);return [...v].reduce((sum,c)=>sum+(c==='😀'?17:c==='中'?9:c===' '?3:5),0);};
  const value=search.searchHighlightSegments(text,query,measure),a=[...measured];measured.length=0;expect({value,calls:a}).toEqual({value:oldSearch.searchHighlightSegments(text,query,measure),calls:measured});
  for(const lines of [[],[text],['repeat','repeat','missing'],['ab','bc…','cd'],Array.from(text)]){
   measured.length=0;const value=search.searchHighlightLines(text,lines,query,measure),a=[...measured];measured.length=0;expect({value,calls:a}).toEqual({value:oldSearch.searchHighlightLines(text,lines,query,measure),calls:measured});
  }
  expect(search.searchSnippet(query,text,'body '+text,null)).toBe(oldSearch.searchSnippet(query,text,'body '+text,null));
 }
});
