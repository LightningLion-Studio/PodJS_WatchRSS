import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import hashes from './fixtures/dbg2/sha256.json';
import {ManagedCache,type CachePorts,type CacheEntry} from '../src/cache/managed.ts';
import {ManagedCache as Oracle} from './fixtures/dbg2/cache/managed.ts';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
test('oracle bytes remain frozen at a32a129',()=>{for(const name of ['managed.ts','policy.ts'] as const)expect(digest(readFileSync(new URL('./fixtures/dbg2/cache/'+name+'.txt',import.meta.url),'utf8'))).toBe(hashes[name]);expect(readFileSync(new URL('./fixtures/dbg2/cache/managed.ts',import.meta.url),'utf8')).toBe(readFileSync(new URL('./fixtures/dbg2/cache/managed.ts.txt',import.meta.url),'utf8'));});
async function run(C:typeof ManagedCache|typeof Oracle,scenario:string){
 const files=new Map<string,CacheEntry>(),events:unknown[]=[],jobs:{path:string;finish():void;fail():void}[]=[];let now=100,hashFinish:(()=>void)|undefined;
 const put=(path:string,size=10)=>files.set(path,{path,size,modified:++now,file:true,directory:false});
 const ports:CachePorts={
  list:async directory=>({entries:[...files.values()].filter(e=>e.path.startsWith(directory+'/')&&!e.path.slice(directory.length+1).includes('/'))}),
  stat:async path=>({exists:files.has(path),file:files.get(path)?.file===true,size:files.get(path)?.size??0}),
  remove:async path=>{events.push(['remove',path]);files.delete(path);},touch:async path=>{events.push(['touch',path]);files.get(path)!.modified=++now;},
  digest:async value=>{events.push(['hash',value]);if(scenario==='hash-cancel')await new Promise<void>(r=>hashFinish=r);return digest(value);},
  download:(url,path,headers)=>{events.push(['download',path,headers]);let yes!:()=>void,no!:(e:unknown)=>void;const result=new Promise<void>((a,b)=>{yes=a;no=b;});jobs.push({path,finish(){put(path);yes();},fail(){no(Error('fixture_failure'));}});return {result,cancel(){events.push(['cancel',path]);no(Error('transport_cancelled'));}};},
 };
 const cache=new C(ports);const stop=cache.subscribe(bytes=>events.push(['usage',bytes]));
 if(scenario==='hash-cancel'){const request=cache.acquire('https://x/1');void request.result.catch(()=>{});await tick();request.cancel();hashFinish!();events.push(['result',await request.result.catch(e=>e.message)]);}
 else if(scenario==='shared'){
  const a=cache.acquire('https://x/a',{Z:'z',A:'a'}),b=cache.acquire('https://x/a',{A:'a',Z:'z'}),c=cache.acquire('https://x/a',{A:'other'});void a.result.catch(()=>{});await tick();a.cancel();for(const j of jobs)j.finish();const [x,y]=await Promise.all([b.result,c.result]);events.push(['paths',x.path,y.path]);await cache.configure(0);x.release();x.release();y.release();await cache.maintain();await a.result.catch(e=>events.push(['result',e.message]));
 }else if(scenario==='clear'){
  let cleared=0;const pin='managed-cache/bili-preview/'+digest('pin')+'.mp4.part';put(pin);cache.registerProducer('bili-preview',{pins:()=>new Set([pin]),clear:async()=>{events.push('producer-clear');},cleared:()=>{cleared++;events.push('producer-cleared');}});
  const a=cache.acquire('https://x/clear',{},false,'bili-preview'),b=cache.acquire('https://x/other');void a.result.catch(()=>{});await tick();jobs.find(j=>j.path.includes('/images/'))!.finish();const lease=await b.result;await cache.clearBucket('bili-preview');events.push(['result',await a.result.catch(e=>e.message),cleared]);lease.release();
 }else if(scenario==='queue'){
  const requests=Array.from({length:7},(_,i)=>cache.acquire('https://x/'+i));requests.forEach(r=>void r.result.catch(()=>{}));await tick();requests.forEach(r=>r.cancel());await Promise.allSettled(requests.map(r=>r.result));
 }else if(scenario==='staging'){
  const a=cache.acquire('https://x/staging');await tick();const staged=jobs[0]!.path+'.download-1';put(staged);put('managed-cache/images/unknown.tmp');await cache.configure(0);jobs[0]!.finish();const lease=await a.result;lease.release();await cache.maintain();
 }else if(scenario==='offline'){
  const directory='managed-cache/rss-offline/channel';files.set(directory,{path:directory,file:false,directory:true,size:0,modified:0});put(directory+'/body.txt',100);put('managed-cache/douyin-preload/'+digest('d')+'.mp4',20);await cache.configure(0);
 }else if(scenario==='invalid'){
  for(const value of [-1,NaN,1.2])events.push(await cache.configure(value).catch(e=>e.message));for(const url of ['file:///x','data:image/png,a'])events.push(await cache.acquire(url).result.catch(e=>e.message));
 }else if(scenario==='eviction'){
  for(let i=0;i<16;i++)put('managed-cache/douyin-preload/'+digest('d'+i)+'.mp4',11);
  put('managed-cache/images/'+digest('inline')+'.inline.img',129*1024*1024);put('managed-cache/images/'+digest('general')+'.img',10);put('managed-cache/rss-offline/body',200);await cache.configure(64);
 }else if(scenario==='repair'){
  const url='https://x/repair',path='managed-cache/images/'+digest(JSON.stringify([url,[]]))+'.img';put(path,1);ports.validate=async p=>{if(files.get(p)?.size!==10)throw Error('invalid_image');};const r=cache.acquire(url);await tick();jobs[0]!.finish();(await r.result).release();
 }
 await tick();await cache.maintain();stop();return {events,files:[...files.values()]};
}
for(const scenario of ['hash-cancel','shared','clear','queue','staging','offline','invalid','eviction','repair'])test('frozen cache differential: '+scenario,async()=>{expect(await run(ManagedCache,scenario)).toEqual(await run(Oracle,scenario));});
