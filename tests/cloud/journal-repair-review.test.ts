import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const encoder=new TextEncoder();
function fixture(stop=''){
 const original=encoder.encode('汉😀verified\n{torn'),files=new Map<string,Uint8Array>([['journal.delta',original]]);let next=0;const readers=new Map<string,string>();
 const request=async<T>(method:string,a:any):Promise<T>=>{
  let value:any;
  switch(method){
   case 'file.stat':{const body=files.get(a.path);value={exists:!!body,file:!!body,size:body?.length??0};break;}
   case 'file.openText':{const text=new TextDecoder('utf-8',{fatal:a.strictUtf8===true}).decode(files.get(a.path)!);const id=String(++next);readers.set(id,text);value={id};break;}
   case 'file.readTextChunk':{const text=readers.get(a.id)!;readers.set(a.id,'');value={text,eof:true};break;}
   case 'file.closeText':readers.delete(a.id);value={closed:true};break;
   case 'file.createTemp':{const path='watch-cloud-cache/.pod-write-'+(++next)+'.part';files.set(path,new Uint8Array());value={path};break;}
   case 'file.read':{const body=files.get(a.path)!;value={offset:a.offset,size:body.length,dataBase64:Buffer.from(body.subarray(a.offset,a.offset+a.maxBytes)).toString('base64')};break;}
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
 const io={chunks:f.ports.files.textChunks!.bind(f.ports.files),repair:f.ports.files.repairJournal!.bind(f.ports.files),read:async(p:string)=>{const bytes=f.files.get(p);return bytes?new TextDecoder().decode(bytes):undefined;},replace:async(p:string,s:string)=>{f.files.set(p,encoder.encode(s));},append:async(p:string,s:string,n:number)=>{expect(f.files.get(p)?.length??0).toBe(n);f.files.set(p,Buffer.concat([f.files.get(p)??new Uint8Array(),encoder.encode(s)]));},yieldTurn:async()=>{}};
 const journal=new JsonDeltaJournal(io,'journal',['rows']);expect(await journal.load()).toEqual({rows:{a:edits[0].value}});expect(f.files.get('journal.delta')).toEqual(encoder.encode(frame));
 await journal.commit({rows:{a:edits[0].value,b:'after'}});expect(await new JsonDeltaJournal(io,'journal',['rows']).load()).toEqual({rows:{a:edits[0].value,b:'after'}});
});
