import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {JsonDeltaJournal as Legacy} from './fixtures/json-journal-legacy';
import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
import {WatchCloudCache} from '../../src/cloud/cache';
import {utf8Decode} from '../../src/cloud/types';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const encoder=new TextEncoder();
function fixture(stop='',maxRead=262144){
 const original=encoder.encode('汉😀verified\n{torn'),files=new Map<string,Uint8Array>([['journal.delta',original]]);let next=0;const readers=new Map<string,{text:string;invalidUtf8:boolean}>();
 const request=async<T>(method:string,a:any):Promise<T>=>{
  let value:any;
  switch(method){
   case 'runtime.delay':value={};break;
   case 'crypto.hash':value={digestBase64:createHash('sha256').update(Buffer.from(a.dataBase64,'base64')).digest('base64')};break;
   case 'file.stat':{const body=files.get(a.path);value={exists:!!body,file:!!body,size:body?.length??0};break;}
   case 'file.openText':{const text=new TextDecoder('utf-8',{fatal:a.strictUtf8===true}).decode(files.get(a.path)!);const id=String(++next);let invalidUtf8=false;try{new TextDecoder('utf-8',{fatal:true}).decode(files.get(a.path)!);}catch{invalidUtf8=true;}readers.set(id,{text,invalidUtf8});value={id};break;}
   case 'file.readTextChunk':{const {text,invalidUtf8}=readers.get(a.id)!;readers.delete(a.id);value={text,eof:true,invalidUtf8};break;}
   case 'file.closeText':readers.delete(a.id);value={closed:true};break;
   case 'file.createTemp':{const path='watch-cloud-cache/.pod-write-'+(++next)+'.part';files.set(path,new Uint8Array());value={path};break;}
   case 'file.read':{const body=files.get(a.path)!;value={offset:a.offset,size:body.length,dataBase64:Buffer.from(body.subarray(a.offset,a.offset+Math.min(a.maxBytes,maxRead))).toString('base64')};break;}
   case 'file.write':{if(stop==='copy')throw Error(stop);const before=files.get(a.path)!,part=Buffer.from(a.dataBase64,'base64');expect(a.expectedOffset).toBe(before.length);files.set(a.path,Buffer.concat([before,part]));value={size:before.length+part.length};break;}
   case 'file.hash':if(stop==='hash')throw Error(stop);value={sha256:hash(files.get(a.path)!)};break;
   case 'file.commit':{if(stop==='before-publish')throw Error(stop);const body=files.get(a.path)!;expect(body.length).toBe(a.expectedSize);expect(hash(body)).toBe(a.expectedSha256);files.set(a.target,body);files.delete(a.path);if(stop==='after-publish')throw Error(stop);value={};break;}
   case 'file.delete':files.delete(a.path);value={};break;
   default:throw Error(method);
  }return value as T;
 };
 return {original,files,readers,ports:createCloudHostPorts(request,{require(){}})};
}
test('prefix repair keeps the original until atomic publication and cleans every temporary',async()=>{
 for(const stop of ['', 'copy','hash','before-publish','after-publish'])for(const newline of [false,true]){
  const f=fixture(stop),prefix=encoder.encode('汉😀verified\n'),task=f.ports.files.repairJournal!('journal.delta',prefix.length,newline);
  if(stop)await expect(task).rejects.toThrow(stop);else await task;
  const expected=!stop||stop==='after-publish'?Buffer.concat([prefix,...(newline?[Buffer.from('\n')]:[])]):f.original;
  expect(f.files.get('journal.delta')).toEqual(expected);expect([...f.files.keys()]).toEqual(['journal.delta']);
 }
});
for(const mode of ['torn-unicode','accepted-replacement','malformed-before-bad-tail','literal-replacement'] as const)test('stream repair retains the legacy decoded prefix: '+mode,async()=>{
 const f=fixture(),raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw));
 const edits=[{field:'rows',key:'a',value:mode==='torn-unicode'?'durable':'�'}],frame=JSON.stringify({base,sequence:1,edits,digest:hash(encoder.encode(JSON.stringify([base,1,edits])))})+'\n';
 f.files.set('journal',encoder.encode(raw));
 let tail=Buffer.from(frame);
 if(mode==='torn-unicode')tail=Buffer.concat([tail,Buffer.from('{"torn":"'),Buffer.from([0xf0,0x9f])]);
 else if(mode==='accepted-replacement'||mode==='malformed-before-bad-tail'){const at=tail.indexOf(Buffer.from('�'));tail=Buffer.concat([tail.subarray(0,at),Buffer.from([255]),tail.subarray(at+3)]);if(mode==='malformed-before-bad-tail')tail=Buffer.concat([tail,Buffer.from('{bad')]);}
 f.files.set('journal.delta',tail);
 const io={chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:f.ports.files.repairJournal!.bind(f.ports.files),read:async(p:string)=>{const bytes=f.files.get(p);return bytes?utf8Decode(bytes):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},append:async(p:string,s:string,n:number)=>{expect(f.files.get(p)?.length??0).toBe(n);f.files.set(p,Buffer.concat([f.files.get(p)??new Uint8Array(),encoder.encode(s)]));},yieldTurn:async()=>{}};
 const oldFiles=new Map(f.files),oldIO={...io,read:async(p:string)=>{const b=oldFiles.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,text:string)=>{oldFiles.set(p,encoder.encode(text));}};
 let expected:any,oldFailure:unknown;try{expected=await new Legacy(oldIO,'journal',['rows']).load();}catch(error){oldFailure=error;}
 const journal=new JsonDeltaJournal(io,'journal',['rows']);
 if(oldFailure){await expect(journal.load()).rejects.toThrow();expect(f.files.get('journal.delta')).toEqual(tail);return;}
 expect(await journal.load()).toEqual(expected);expect(f.files.get('journal.delta')).toEqual(oldFiles.get('journal.delta'));
 await journal.commit({rows:{...expected.rows,b:'after'}});expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{...expected.rows,b:'after'}});
});

for(const spelling of ['value','lf-2','lf-3','lf-4','all-lf'] as const)for(const maxRead of [1,2,3,7,131072])for(const ending of ['complete','no-newline','bad-tail','bad-digest'] as const)test('R2-1/R3-1 retains the historical whole-file interpretation: '+spelling+' '+ending+' bytes='+maxRead,async()=>{
 const f=fixture('',maxRead),raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw));
 const frame=(sequence:number,key:string,value:string)=>{const edits=[{field:'rows',key,value}];return JSON.stringify({base,sequence,edits,digest:hash(encoder.encode(JSON.stringify([base,sequence,edits])))})+'\n';};
 const first=frame(1,'stable','汉😀'),second=frame(2,'problem','/'),third=frame(3,'after','last valid');
 const slash=Buffer.from(second).indexOf(Buffer.from('"value":"/"'))+9;
 expect(Buffer.from(second)[slash]).toBe(47);
 let malformed=Buffer.concat([Buffer.from(second).subarray(0,slash),Buffer.from([0xc0,0xaf]),Buffer.from(second).subarray(slash+1)]);
 if(ending==='bad-digest')malformed=Buffer.from(malformed.toString().replace(/"digest":"[a-f0-9]{64}"/,'"digest":"'+'0'.repeat(64)+'"'));
 let source=Buffer.concat([Buffer.from(first),malformed,Buffer.from(third)]);
 if(spelling!=='value'){const original=Buffer.from(first+second+third),lf=original.indexOf(10),bad=spelling==='lf-3'?[0xe0,0x80,0x8a]:spelling==='lf-4'?[0xf0,0x80,0x80,0x8a]:[0xc0,0x8a];source=Buffer.concat([original.subarray(0,lf),Buffer.from(bad),original.subarray(lf+1)]);if(spelling==='all-lf')source=Buffer.concat([...original].map(b=>b===10?Buffer.from(bad):Buffer.from([b])));if(ending==='bad-digest')source=Buffer.from(source.toString('binary').replace(/("sequence":2.*?"digest":")[a-f0-9]+"/,'$1'+'0'.repeat(64)+'"'),'binary');}
 if(ending==='no-newline')source=source.subarray(0,source.length-1);
 if(ending==='bad-tail')source=Buffer.concat([source,Buffer.from('{torn')]);
 f.files.set('journal',encoder.encode(raw));f.files.set('journal.delta',source);
 // The actual historical application decoder accepts C0 AF as slash. Verify
 // the legacy checksum algorithm independently of the new reader's fallback.
 const oldLines=utf8Decode(source).split('\n'),oldRows:Record<string,string>={};
 for(const line of oldLines){if(!line)break;let v:any;try{v=JSON.parse(line);}catch{break;}
  if(v.digest!==hash(encoder.encode(JSON.stringify([v.base,v.sequence,v.edits]))))break;
  for(const edit of v.edits)oldRows[edit.key]=edit.value;
 }
 const io={chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:f.ports.files.repairJournal!.bind(f.ports.files),
  read:async(p:string)=>{const b=f.files.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},
  append:async(p:string,s:string,n:number)=>{expect(f.files.get(p)?.length??0).toBe(n);f.files.set(p,Buffer.concat([f.files.get(p)??new Uint8Array(),encoder.encode(s)]));},yieldTurn:async()=>{}};
 const journal=new JsonDeltaJournal(io,'journal',['rows']);
 expect(await journal.load()).toEqual({rows:oldRows});
 expect(oldRows).toEqual(ending==='bad-digest'?{stable:'汉😀'}:spelling==='all-lf'&&ending==='no-newline'?{stable:'汉😀',problem:'/'}:{stable:'汉😀',problem:'/',after:'last valid'});
 // No stream-derived prefix repair: only the old loader can decide it.
 const oldFiles=new Map([['journal',encoder.encode(raw)],['journal.delta',source]]);
 const oldIO={...io,read:async(p:string)=>{const b=oldFiles.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,text:string)=>{oldFiles.set(p,encoder.encode(text));}};
 expect(await new Legacy(oldIO,'journal',['rows']).load()).toEqual({rows:oldRows});
 expect(f.files.get('journal.delta')).toEqual(oldFiles.get('journal.delta'));
 await journal.commit({rows:{...oldRows,appended:'after recovery'}});
 expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{...oldRows,appended:'after recovery'}});
 expect([...f.files.keys()].sort()).toEqual(['journal','journal.delta']);
});

for(const spelling of ['value','lf-2','lf-3','lf-4'])test('production cache wires historical decoding through host ports: '+spelling,async()=>{
 const f=fixture(),cache=new WatchCloudCache(f.ports.files,async b=>hash(b),{require(){}}),path=(await cache.scope('synthetic'))+'/records.json';
 const raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw));let source='';
 for(const [index,[key,value]] of [['stable','汉😀'],['problem','/'],['after','last valid']].entries()){
  const edits=[{field:'rows',key,value}];source+=JSON.stringify({base,sequence:index+1,edits,digest:hash(encoder.encode(JSON.stringify([base,index+1,edits])))})+'\n';
 }
 const at=spelling==='value'?Buffer.from(source).indexOf(Buffer.from('"value":"/"'))+9:Buffer.from(source).indexOf(10),bad=spelling==='value'?[0xc0,0xaf]:spelling==='lf-3'?[0xe0,0x80,0x8a]:spelling==='lf-4'?[0xf0,0x80,0x80,0x8a]:[0xc0,0x8a];
 f.files.set(path,encoder.encode(raw));f.files.set(path+'.delta',Buffer.concat([Buffer.from(source).subarray(0,at),Buffer.from(bad),Buffer.from(source).subarray(at+1)]));
 const expected={rows:{stable:'汉😀',problem:'/',after:'last valid'},projections:[]};
 expect(await cache.recordsValue('synthetic')).toEqual(expected);
 expect(f.files.get(path+'.delta')!.length).toBeGreaterThan(0);
 expect(await new WatchCloudCache(f.ports.files,async b=>hash(b),{require(){}}).recordsValue('synthetic')).toEqual(expected);
 expect([...f.files.keys()].some(p=>p.includes('.pod-write-'))).toBe(false);
});

test('1000 random byte corruptions: new accepted frames contain every legacy accepted frame',async()=>{
 let state=0x31f00d;const random=(max:number)=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};
 const raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw)),frames=[];
 for(let sequence=1;sequence<=5;sequence++){const edits=[{field:'rows',key:'frame-'+sequence,value:'authenticated / 汉😀 '+sequence}];frames.push(JSON.stringify({base,sequence,edits,digest:hash(encoder.encode(JSON.stringify([base,sequence,edits])))})+'\n');}
 const original=Buffer.from(frames.join(''));let acceptedAll=0,acceptedSome=0,fallbacks=0,rejected=0;
 for(let sample=0;sample<1000;sample++){
  let source:Uint8Array=Buffer.from(original);
  if(sample%5===0){
   // Include non-vacuous historical successes among arbitrary byte damage.
   const token=sample%10===0?10:47,at=source.indexOf(token),width=2+random(3),encoded=width===2?[0xc0,0x80|token]:width===3?[0xe0,0x80,0x80|token]:[0xf0,0x80,0x80,0x80|token];
   source=Buffer.concat([source.subarray(0,at),Buffer.from(encoded),source.subarray(at+1)]);
  }else for(let change=0,n=1+random(4);change<n;change++){
   const at=random(source.length+1),count=1+random(4),noise=Buffer.from(Array.from({length:count},()=>random(256)));
   switch(random(5)){
    case 0:source=Buffer.concat([source.subarray(0,at),noise,source.subarray(at+count)]);break;
    case 1:source=Buffer.concat([source.subarray(0,at),noise,source.subarray(at)]);break;
    case 2:source=Buffer.concat([source.subarray(0,at),source.subarray(at+count)]);break;
    case 3:source=source.subarray(0,at);break;
    case 4:source=Buffer.concat([source.subarray(0,at),Buffer.from([0xc0,0x8a]),source.subarray(at+1)]);break;
   }
  }
  if(Buffer.from(source).equals(original))source=Buffer.concat([source,Buffer.from([255])]);
  expect(Buffer.from(source).equals(original)).toBe(false);
  const f=fixture('',sample%3===0?257:262144);f.files.set('journal',encoder.encode(raw));f.files.set('journal.delta',source);
  const oldFiles=new Map([['journal',encoder.encode(raw)],['journal.delta',source]]);let fullReads=0;
  const port=(files:Map<string,Uint8Array>)=>({read:async(p:string)=>{const b=files.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,text:string)=>{files.set(p,encoder.encode(text));},append:async()=>{throw Error('read only');},yieldTurn:async()=>{}});
  const old=new Legacy(port(oldFiles),'journal',['rows'],v=>v,v=>v,1e9);let expected:any,oldFailure:unknown;try{expected=await old.load();}catch(error){oldFailure=error;}
  const basic=port(f.files),current=new JsonDeltaJournal({...basic,read:async p=>{if(p.endsWith('.delta'))fullReads++;return basic.read(p);},chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:async()=>{throw Error('stream must never repair');}},'journal',['rows'],v=>v,v=>v,1e9);
  if(oldFailure){await expect(current.load(),'sample '+sample).rejects.toThrow();expect(f.files.get('journal.delta')).toEqual(source);expect(f.readers.size).toBe(0);rejected++;continue;}
  const actual=await current.load(),oldSequence=(old as any).sequence,newSequence=(current as any).sequence;
  expect(newSequence,'sample '+sample).toBeGreaterThanOrEqual(oldSequence);
  for(let sequence=1;sequence<=oldSequence;sequence++)expect(actual.rows['frame-'+sequence],'sample '+sample).toBe(expected.rows['frame-'+sequence]);
  expect(actual,'sample '+sample).toEqual(expected);
  expect(f.files.get('journal.delta'),'legacy prefix decision at sample '+sample).toEqual(oldFiles.get('journal.delta'));
  expect(fullReads).toBeLessThanOrEqual(1);fallbacks+=fullReads;
  expect(f.readers.size).toBe(0);
  if(oldSequence===5)acceptedAll++;if(oldSequence>0)acceptedSome++;
 }
 expect(acceptedAll).toBeGreaterThanOrEqual(200);expect(acceptedSome).toBeGreaterThan(acceptedAll);expect(fallbacks+rejected).toBeGreaterThanOrEqual(800);console.log(JSON.stringify({samples:1000,acceptedAll,acceptedSome,fallbacks,rejected,seed:'0x31f00d'}));
},30000);

for(const marker of ['base','delta'] as const)test('R4-1 literal U+FFFD in large '+marker+' keeps cold loads streaming and small commits incremental',async()=>{
 const f=fixture(),user='synthetic-large',counts={baseReads:0,deltaReads:0,baseWrites:0,appends:0};let path='';
 const files={...f.ports.files,read:async(p:string)=>{if(p===path)counts.baseReads++;if(p===path+'.delta')counts.deltaReads++;return f.ports.files.read(p);},
  writeAtomic:async(p:string,b:Uint8Array)=>{if(p===path)counts.baseWrites++;return f.ports.files.writeAtomic(p,b);},
  append:async(p:string,b:Uint8Array,n:number)=>{counts.appends++;return f.ports.files.append!(p,b,n);}};
 const make=()=>new WatchCloudCache(files,async b=>hash(b),{require(){}});
 path=(await make().scope(user))+'/records.json';
 const seed=(marker==='base'?'合法 � 文本':'合法 汉😀 文本')+'x'.repeat(15*1024*1024),raw=JSON.stringify({rows:{seed}}),base=hash(encoder.encode(raw)),frames=[];
 for(let sequence=1;sequence<=1024;sequence++){
  const edits=[{field:'rows',key:'frame-'+sequence,value:(marker==='delta'?'合法 � 文本':'合法 汉😀 文本')+'x'.repeat(17*1024)}];
  frames.push(JSON.stringify({base,sequence,edits,digest:hash(encoder.encode(JSON.stringify([base,sequence,edits])))})+'\n');
 }
 const beforeBase=encoder.encode(raw),beforeDelta=encoder.encode(frames.join(''));f.files.set(path,beforeBase);f.files.set(path+'.delta',beforeDelta);
 expect(beforeBase.length).toBeGreaterThan(15*1024*1024);expect(beforeDelta.length).toBeGreaterThan(17*1024*1024);expect(beforeDelta.length).toBeLessThan(32*1024*1024);
 for(let cold=1;cold<=3;cold++){
  const cache=make(),value=await cache.recordsValue(user);expect(value.rows.seed).toBe(seed);expect(Object.keys(value.rows).length).toBe(1025);
  await cache.storeRecordsValue(user,{...value,cold});expect(f.files.get(path)).toBe(beforeBase);expect(f.readers.size).toBe(0);
 }
 expect(counts).toEqual({baseReads:3,deltaReads:0,baseWrites:0,appends:3});
 const written=f.files.get(path+'.delta')!.length-beforeDelta.length;expect(written).toBeGreaterThan(0);expect(written).toBeLessThan(2048);
 console.log(JSON.stringify({marker,baseBytes:beforeBase.length,deltaBytes:beforeDelta.length,...counts,written}));
},60000);

test('R4-1 actual invalid bytes outside the digest payload still trigger historical replay',async()=>{
 const f=fixture(),raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw)),edits=[{field:'rows',key:'kept',value:'authenticated'}];
 const frame=JSON.stringify({base,sequence:1,edits,digest:hash(encoder.encode(JSON.stringify([base,1,edits]))),extra:'/'})+'\n',bytes=Buffer.from(frame),at=bytes.indexOf('"extra":"/"')+9;
 expect(bytes[at]).toBe(47);f.files.set('journal',encoder.encode(raw));f.files.set('journal.delta',Buffer.concat([bytes.subarray(0,at),Buffer.from([0xc0,0xaf]),bytes.subarray(at+1)]));let reads=0;
 const io={chunks:f.ports.files.textChunks!.bind(f.ports.files),read:async(p:string)=>{if(p.endsWith('.delta'))reads++;const b=f.files.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},append:async()=>{throw Error('unexpected append');},yieldTurn:async()=>{}};
 const journal=new JsonDeltaJournal(io,'journal',['rows']);expect(await journal.load()).toEqual({rows:{kept:'authenticated'}});expect(reads).toBe(1);expect(f.readers.size).toBe(0);
 await journal.commit({rows:{kept:'authenticated',after:'canonical'}});expect(f.files.get('journal.delta')!.length).toBe(0);
 expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{kept:'authenticated',after:'canonical'}});
});
