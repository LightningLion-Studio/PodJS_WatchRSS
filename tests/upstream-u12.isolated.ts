import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const transpiler=new Bun.Transpiler({loader:'ts'});
async function original(rel:string){
 const text=readFileSync(import.meta.dir+'/fixtures/upstream-u12/'+rel.replaceAll('/','_')+'.txt','utf8');
 const relocated=text.replace(/(from\s*['"])(\.[^'"]+)(['"])/g,(_all,first,path,last)=>first+resolve(import.meta.dir,'..',dirname(rel),path)+last);
 return import('data:text/javascript;base64,'+Buffer.from(transpiler.transformSync(relocated)).toString('base64'));
}
const old=await original('src/navigation/activity-navigation.ts');const current=await import('../src/navigation/activity-navigation.ts');
const empty=()=>({saved:{},retained:{}});
test('stack capture/restore retains exact codec, bounds, valid-prefix, identity and resolver behavior',async()=>{
 for(let sample=0;sample<35;sample++){
  const build=()=>[{page:'home'},{page:'settings'},{page:'add-rss',addUrl:'é😀'+sample},{page:'debug-tools'}] as any[];
  const a=build(),b=build();
  for(let i=0;i<a.length;i++){old.routeMemory(a[i]).saved.text='汉'.repeat(sample*30);old.routeMemory(a[i]).retained.text='draft'+sample;current.routeMemory(b[i]).saved.text='汉'.repeat(sample*30);current.routeMemory(b[i]).retained.text='draft'+sample;}
  const before={saved:{other:17},retained:{other:19}};
  const prior=old.captureActivityNavigation(before,a),next=current.captureActivityNavigation(before,b);expect(next).toEqual(prior);
  for(const debug of [false,true])expect(current.restoreActivityNavigation(next,debug)).toEqual(old.restoreActivityNavigation(prior,debug));
  expect(current.restoreActivityNavigation({saved:next.saved,retained:{}})).toEqual(old.restoreActivityNavigation({saved:prior.saved,retained:{}}));
  for(const change of [(v:any)=>v.entries[1].id=v.entries[0].id,(v:any)=>v.entries[1].page='unknown',(v:any)=>v.entries[1].id='bad',(v:any)=>v.version=99]){
   const x=structuredClone(prior),y=structuredClone(next);change(x.saved[old.CONTENT_ACTIVITY_KEY]);change(y.saved[current.CONTENT_ACTIVITY_KEY]);expect(current.restoreActivityNavigation(y,true)).toEqual(old.restoreActivityNavigation(x,true));
  }
 }
 for(const api of [old,current]){
  const snapshot=api.captureActivityNavigation(empty(),[{page:'home',memory:{id:'r900000',saved:{},retained:{}}},{page:'reader',articleId:'a'}]);
  api.restoreActivityNavigation(snapshot);expect(api.routeMemory({page:'home'}).id).toBe('r900001');
 }
 const callsA:any[]=[],callsB:any[]=[];
 const entries=()=>[{page:'home'},{page:'reader',articleId:'a'},{page:'articles',channelId:'gone'}] as any[];
 const resolver=(calls:any[])=>({canRestore:(e:any)=>{calls.push(['can',e.page]);return true;},hasChannel:(id:string)=>{calls.push(['channel',id]);return false;},article:async(id:string)=>{calls.push(['article',id]);return {id,title:'restored',content:''};}});
 expect(await current.resolveActivityNavigation(entries(),resolver(callsB))).toEqual(await old.resolveActivityNavigation(entries(),resolver(callsA)));expect(callsB).toEqual(callsA);
});


test('entity-free prefixes stay synchronous and entity lookup yields only at its original await boundary',async()=>{
 async function sequence(api:any,reader:boolean){
  const calls:string[]=[];let finish!:(value:any)=>void;
  const article=new Promise(resolve=>finish=resolve);
  const task=api.resolveActivityNavigation([{page:'home'},...(reader?[{page:'reader',articleId:'x'}]:[]),{page:'articles',channelId:'present'}],{
   canRestore(e:any){calls.push('can:'+e.page);return true;},hasChannel(){calls.push('channel');return true;},article(){calls.push('article');return article;}
  });
  calls.push('returned');finish({id:'x',content:''});
  await Promise.resolve();calls.push('microtask');await task;calls.push('resolved');return calls;
 }
 for(const reader of [false,true])expect(await sequence(current,reader)).toEqual(await sequence(old,reader));
});

test('old and new host log files have identical UTF-8 chunks, atomic publication and error cleanup',async()=>{
 const legacy=await original('src/logs/logger-host.ts');const {createHostLogFile}=await import('../src/logs/logger-host.ts');
 async function run(factory:any){
  const map=new Map<string,Buffer>(),calls:any[]=[];let sequence=0,fail=false;
  const ports:any={stat:async(p:string)=>({exists:map.has(p),size:map.get(p)?.length??0}),read:async(p:string,offset:number,max:number)=>{calls.push(['read',p,offset,max]);const b=map.get(p)!;return {offset,size:b.length,eof:offset+max>=b.length,dataBase64:b.subarray(offset,offset+max).toString('base64')};},
   write:async(p:string,s:string)=>{calls.push(['write',p,s]);map.set(p,Buffer.from(s,'base64'));},append:async(p:string,s:string,offset:number)=>{calls.push(['append',p,s,offset]);const b=Buffer.from(s,'base64'),old=map.get(p)!;map.set(p,Buffer.concat([old,b]));return {size:old.length+b.length};},
   createTemp:async(dir:string)=>{const path=dir+'/'+ ++sequence;calls.push(['temp',dir]);map.set(path,Buffer.alloc(0));return {path};},hash:async(p:string)=>({size:map.get(p)!.length,sha256:createHash('sha256').update(map.get(p)!).digest('hex')}),commit:async(p:string,target:string,size:number,hash:string)=>{calls.push(['commit',p,target,size,hash]);if(fail)throw Error('fail');map.set(target,map.get(p)!);map.delete(p);},remove:async(p:string)=>{calls.push(['remove',p]);map.delete(p);}};
  const file=factory(ports),results:any[]=[];results.push(await file.read());const value='甲'.repeat(25000)+'😀\0';await file.append(value,0);results.push(await file.read(),await file.size());await file.replace('new');results.push(await file.read());fail=true;try{await file.replace('bad');}catch(e){results.push(String(e));}results.push(await file.read(),[...map.keys()]);return {results,calls};
 }
 expect(await run(createHostLogFile)).toEqual(await run(legacy.createHostLogFile));
});
