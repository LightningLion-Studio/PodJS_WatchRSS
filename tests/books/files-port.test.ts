import {test,expect} from 'bun:test';
import {createBookFiles} from '../../src/books/files-port';
import {createHash} from 'node:crypto';
function fixture(maxWrite=65536){const files=new Map<string,Uint8Array>(),leases=new Set<string>(),readers=new Map<string,{text:string;offset:number}>();let serial=0,peak=0,strict=false;const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');const host=async<T>(method:string,a:Record<string,any>):Promise<T>=>{let r:any;
 if(method==='file.createTemp'){if(leases.size>=8)throw Error('lease cap');const path='books/.pod-write-'+(++serial)+'.part';files.set(path,new Uint8Array());leases.add(path);peak=Math.max(peak,leases.size);r={path};}
 else if(method==='file.write'){const before=files.get(a.path)!;if(a.append)expect(a.expectedOffset).toBe(before.length);const b=Buffer.from(a.dataBase64,'base64');expect(b.length).toBeLessThanOrEqual(maxWrite);const next=Buffer.concat([a.append?before:new Uint8Array(),b]);files.set(a.path,next);r={size:next.length};}
 else if(method==='file.hash'){const b=files.get(a.path);if(!b)throw Error('missing');r={size:b.length,sha256:hash(b)};}
 else if(method==='file.commit'){const b=files.get(a.path)!;expect(b.length).toBe(a.expectedSize);expect(hash(b)).toBe(a.expectedSha256);files.set(a.target,b);files.delete(a.path);leases.delete(a.path);r={path:a.target,size:b.length,sha256:hash(b)};}
 else if(method==='runtime.delay')r=null;
 else if(method==='file.compose'){const b=Buffer.concat(a.parts.map((p:any)=>files.get(p.path)!));expect(hash(b)).toBe(a.expectedSha256);files.set(a.target,b);r={path:a.target,size:b.length,sha256:hash(b)};}
 else if(method==='file.delete'){files.delete(a.path);leases.delete(a.path);r={};}
 else if(method==='file.stat'){r={exists:files.has(a.path),size:files.get(a.path)?.length??0};}
 else if(method==='file.read'){const b=files.get(a.path)!;r={size:b.length,dataBase64:Buffer.from(b.subarray(a.offset,a.offset+a.maxBytes)).toString('base64')};}
 else if(method==='file.openText'){strict=a.strictUtf8===true;const id='r'+(++serial);readers.set(id,{text:new TextDecoder('utf-8',{fatal:strict}).decode(files.get(a.path)),offset:0});r={id};}
 else if(method==='file.readTextChunk'){const v=readers.get(a.id)!;const text=v.text.slice(v.offset,v.offset+7);v.offset+=text.length;r={text,eof:v.offset===v.text.length};}
 else if(method==='file.closeText'){readers.delete(a.id);r={};}else throw Error(method);return r as T;};return {port:createBookFiles(host),files,leases,readers,peak:()=>peak,strict:()=>strict};}
test('many durable BLE parts do not exhaust native temp leases; streaming combine and atomic publication retain exact bytes',async()=>{const f=fixture(),parts=[];for(let i=0;i<12;i++)parts.push(await f.port.writeBytes(new TextEncoder().encode('章😀'+i+'\n')));expect(f.peak()).toBe(1);expect(f.leases.size).toBe(0);const combined=await f.port.combine(parts.map(p=>p.path),10000),published=await f.port.publish(combined,'a'.repeat(64));const lines=[];for await(const l of f.port.lines(published.path))lines.push(l);expect(lines).toEqual(Array.from({length:12},(_,i)=>'章😀'+i));expect(f.strict()).toBe(true);expect(f.readers.size).toBe(0);expect(f.leases.size).toBe(0);await expect(f.port.read('../outside',0,1)).rejects.toThrow('path');expect(f.files.has(published.path)).toBe(true);});
test('stream overflow cleans only its temporary owned path',async()=>{const f=fixture();async function* lines(){yield '汉'.repeat(100000);}await expect(f.port.write(lines(),100)).rejects.toThrow();expect(f.leases.size).toBe(0);expect(f.files.size).toBe(0);});


test('checkpointed default book files use bounded native streaming hash without injected dependencies; absent large-hash capability fails closed',async()=>{
 const g=globalThis as any,previous=g.__podByteCodecs,owned=Object.prototype.hasOwnProperty.call(g,'__podByteCodecs');
 try{const updates:number[]=[];g.__podByteCodecs={sha256Create:()=>{const hash=createHash('sha256');return {update:(b:Uint8Array)=>{updates.push(b.length);hash.update(b);return true;},finish:()=>new Uint8Array(hash.digest())};}};
  const f=fixture(262144),body=new Uint8Array(524305).fill(37),units=new Set<string>(),checkpoint={scope:async()=> 'current-scope',has:(u:string)=>units.has(u),commit:async(u:string)=>{units.add(u);},check:async()=>{}};
  const info=await f.port.writeBytes(body,checkpoint,'a'.repeat(64));expect(f.files.get(info.path)).toEqual(body);expect(info.path).toBe('books/'+'a'.repeat(64)+'-'+createHash('sha256').update(body).digest('hex')+'.jsonl');expect(updates.every(n=>n<=262144)).toBe(true);expect(f.leases.size).toBe(0);
  delete g.__podByteCodecs;await expect(fixture().port.writeBytes(body,checkpoint)).rejects.toThrow('cloud_snapshot_unit_capacity');
 }finally{if(owned)g.__podByteCodecs=previous;else delete g.__podByteCodecs;}
});
