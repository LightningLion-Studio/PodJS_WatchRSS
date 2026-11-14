import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
import {WatchCloudCache} from '../../src/cloud/cache';
import {utf8Decode} from '../../src/cloud/types';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const encoder=new TextEncoder();
function fixture(stop='',maxRead=262144){
 const original=encoder.encode('汉😀verified\n{torn'),files=new Map<string,Uint8Array>([['journal.delta',original]]);let next=0;const readers=new Map<string,string>();
 const request=async<T>(method:string,a:any):Promise<T>=>{
  let value:any;
  switch(method){
   case 'runtime.delay':value={};break;
   case 'crypto.hash':value={digestBase64:createHash('sha256').update(Buffer.from(a.dataBase64,'base64')).digest('base64')};break;
   case 'file.stat':{const body=files.get(a.path);value={exists:!!body,file:!!body,size:body?.length??0};break;}
   case 'file.openText':{const text=new TextDecoder('utf-8',{fatal:a.strictUtf8===true}).decode(files.get(a.path)!);const id=String(++next);readers.set(id,text);value={id};break;}
   case 'file.readTextChunk':{const text=readers.get(a.id)!;readers.set(a.id,'');value={text,eof:true};break;}
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
 return {original,files,ports:createCloudHostPorts(request,{require(){}})};
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
 const io={legacyLines:f.ports.files.legacyJournalLines!.bind(f.ports.files),chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:f.ports.files.repairJournal!.bind(f.ports.files),read:async(p:string)=>{const bytes=f.files.get(p);return bytes?new TextDecoder().decode(bytes):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},append:async(p:string,s:string,n:number)=>{expect(f.files.get(p)?.length??0).toBe(n);f.files.set(p,Buffer.concat([f.files.get(p)??new Uint8Array(),encoder.encode(s)]));},yieldTurn:async()=>{}};
 const journal=new JsonDeltaJournal(io,'journal',['rows']);expect(await journal.load()).toEqual({rows:{a:edits[0].value}});expect(f.files.get('journal.delta')).toEqual(encoder.encode(frame));
 await journal.commit({rows:{a:edits[0].value,b:'after'}});expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{a:edits[0].value,b:'after'}});
});

for(const maxRead of [1,2,3,7,131072])for(const ending of ['complete','no-newline','bad-tail','bad-digest'] as const)test('R2-1 retains historically authenticated overlong UTF-8 and following frames: '+ending+' bytes='+maxRead,async()=>{
 const f=fixture('',maxRead),raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw));
 const frame=(sequence:number,key:string,value:string)=>{const edits=[{field:'rows',key,value}];return JSON.stringify({base,sequence,edits,digest:hash(encoder.encode(JSON.stringify([base,sequence,edits])))})+'\n';};
 const first=frame(1,'stable','汉😀'),second=frame(2,'problem','/'),third=frame(3,'after','last valid');
 const slash=Buffer.from(second).indexOf(Buffer.from('"value":"/"'))+9;
 expect(Buffer.from(second)[slash]).toBe(47);
 let malformed=Buffer.concat([Buffer.from(second).subarray(0,slash),Buffer.from([0xc0,0xaf]),Buffer.from(second).subarray(slash+1)]);
 if(ending==='bad-digest')malformed=Buffer.from(malformed.toString().replace(/"digest":"[a-f0-9]{64}"/,'"digest":"'+'0'.repeat(64)+'"'));
 let source=Buffer.concat([Buffer.from(first),malformed,Buffer.from(third)]);
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
 const io={legacyLines:f.ports.files.legacyJournalLines!.bind(f.ports.files),chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:f.ports.files.repairJournal!.bind(f.ports.files),
  read:async(p:string)=>{const b=f.files.get(p);return b?utf8Decode(b):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},
  append:async(p:string,s:string,n:number)=>{expect(f.files.get(p)?.length??0).toBe(n);f.files.set(p,Buffer.concat([f.files.get(p)??new Uint8Array(),encoder.encode(s)]));},yieldTurn:async()=>{}};
 const journal=new JsonDeltaJournal(io,'journal',['rows']);
 expect(await journal.load()).toEqual({rows:oldRows});
 expect(oldRows).toEqual(ending==='bad-digest'?{stable:'汉😀'}:{stable:'汉😀',problem:'/',after:'last valid'});
 if(ending!=='bad-digest'){
  // A safe checkpoint writes canonical UTF-8, never Java's replacement text.
  expect(f.files.get('journal.delta')!.length).toBe(0);
  expect(JSON.parse(utf8Decode(f.files.get('journal')!))).toEqual({rows:oldRows});
 }
 await journal.commit({rows:{...oldRows,appended:'after recovery'}});
 expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{...oldRows,appended:'after recovery'}});
 expect([...f.files.keys()].sort()).toEqual(['journal','journal.delta']);
});

test('historical frame bytes cross the raw read boundary without whole-journal reads',async()=>{
 const f=fixture('',131072),prefix='x'.repeat(131071);
 const raw=Buffer.concat([Buffer.from(prefix),Buffer.from([0xc0,0xaf]),Buffer.from('汉😀\nlast\n')]);
 f.files.set('journal.delta',raw);const lines=[];
 for await(const line of f.ports.files.legacyJournalLines!('journal.delta'))lines.push(line);
 expect(lines).toEqual([prefix+'/汉😀','last']);
});

test('production cache wires historical decoding through host ports and atomic canonical publication',async()=>{
 const f=fixture(),cache=new WatchCloudCache(f.ports.files,async b=>hash(b),{require(){}}),path=(await cache.scope('synthetic'))+'/records.json';
 const raw=JSON.stringify({rows:{}}),base=hash(encoder.encode(raw));let source='';
 for(const [index,[key,value]] of [['stable','汉😀'],['problem','/'],['after','last valid']].entries()){
  const edits=[{field:'rows',key,value}];source+=JSON.stringify({base,sequence:index+1,edits,digest:hash(encoder.encode(JSON.stringify([base,index+1,edits])))})+'\n';
 }
 const at=Buffer.from(source).indexOf(Buffer.from('"value":"/"'))+9;
 f.files.set(path,encoder.encode(raw));f.files.set(path+'.delta',Buffer.concat([Buffer.from(source).subarray(0,at),Buffer.from([0xc0,0xaf]),Buffer.from(source).subarray(at+1)]));
 const expected={rows:{stable:'汉😀',problem:'/',after:'last valid'},projections:[]};
 expect(await cache.recordsValue('synthetic')).toEqual(expected);
 expect(f.files.get(path+'.delta')!.length).toBe(0);
 expect(await new WatchCloudCache(f.ports.files,async b=>hash(b),{require(){}}).recordsValue('synthetic')).toEqual(expected);
 expect([...f.files.keys()].some(p=>p.includes('.pod-write-'))).toBe(false);
});
