import {foregroundRequestFilter} from '../../src/sync/action-policy';
import {RfcommLibraryListener,type RfcommPorts} from '../../src/sync/rfcomm';
import {Database} from 'bun:sqlite';
import {mkdir,readFile,rename,stat,readdir,rm,open,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import type {SqlDatabase} from '../../src/core/types';
import {BinaryApplicationService,type BinaryApplicationPorts} from '../../src/sync/library-binary/host';
import {BinaryStore} from '../../src/sync/library-binary/store';
import {type LibrarySessionRepository} from '../../src/sync/session';
import {StreamFrameConnection,type SyncByteStream} from '../../src/sync/stream';
import {VerifiedChunkStore,type VerifiedObject} from '@podjs/framework/verified-chunk-store';
import {WatchAccountStore} from '../../src/account/store';
import {D} from '../../src/sync/library-binary/digests';
import {hash,type Row} from '../../src/sync/library-binary/wire';
import type {BinaryAssetFiles} from '../../src/sync/library-binary/assets';
export const nonce=()=>randomBytes(16).toString('hex');
export function sleep(ms:number){let id:ReturnType<typeof setTimeout>;return {result:new Promise<void>(resolve=>{id=setTimeout(resolve,ms);}),cancel:()=>clearTimeout(id!)};}
class Bytes {
 bytes:Uint8Array[]=[];reader?:()=>void;closed=false;
 push(b:Uint8Array){this.bytes.push(b.slice());this.reader?.();}
 async read(max:number){while(!this.bytes.length){if(this.closed)return null;await new Promise<void>(r=>{this.reader=r;});this.reader=undefined;}const b=this.bytes[0]!,part=b.slice(0,max);if(part.length===b.length)this.bytes.shift();else this.bytes[0]=b.slice(max);return part;}
 close(){this.closed=true;this.reader?.();}
}
export function bytePair(){const a=new Bytes(),b=new Bytes();const close=async()=>{a.close();b.close();};const stream=(input:Bytes,output:Bytes):SyncByteStream=>({read:async max=>input.read(max),write:async bytes=>{if(output.closed)throw Error('closed');output.push(bytes);},close});return {phone:stream(a,b),watch:stream(b,a),close};}
/** Host runtime for product TS, with real fsync files and the same SQLite DB for
 * receipts/business rows. This replaces Android service ports, never B2 logic. */
export async function binaryRuntime(options:{enabled?:boolean;maxObjects?:number;fault?:(method:string,args:Row)=>void|Promise<void>}={}){
 const root=await mkdtemp(join(tmpdir(),'wrss-b2-runtime-'));const sql=new Database(join(root,'business.sqlite'));sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as Row[],execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 const path=(p:string)=>{if(p.includes('..')||p.startsWith('/'))throw Error('LOCAL_IO');return join(root,p);};
 const durable=async(p:string,bytes:Uint8Array)=>{await mkdir(dirname(path(p)),{recursive:true});const f=await open(path(p),'w');try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}};
 const files:BinaryAssetFiles={
  list:async p=>({entries:await readdir(path(p),{withFileTypes:true}).then(es=>Promise.all(es.map(async e=>({path:p+'/'+e.name,file:e.isFile(),size:(await stat(path(p+'/'+e.name))).size})))).catch(()=>[])}),
  stat:async p=>{try{const s=await stat(path(p));return {file:s.isFile(),size:s.size,usableBytes:2**40};}catch{return {file:false,size:0,usableBytes:2**40};}},
  hash:async p=>{const h=createHash('sha256');let size=0;for await(const b of createReadStream(path(p),{highWaterMark:65536})){h.update(b);size+=b.length;}return {size,sha256:h.digest('hex')};},
  readBytes:async(p,offset,max)=>{const f=await open(path(p),'r');try{const size=(await f.stat()).size,b=new Uint8Array(Math.min(max,Math.max(0,size-offset))),r=await f.read(b,0,b.length,offset);return {bytes:b.subarray(0,r.bytesRead),size};}finally{await f.close();}},
  writeBytes:async(p,b)=>{await durable(p,b);return {size:b.length};},
  appendBytes:async(p,b,offset)=>{const f=await open(path(p),'r+');try{if((await f.stat()).size!==offset)throw Error('LOCAL_IO');await f.write(b,0,b.length,offset);await f.sync();return {size:offset+b.length};}finally{await f.close();}},
  createTemp:async dir=>{const p=dir+'/'+nonce();await durable(p,new Uint8Array());return {path:p};},
  commit:async(p,target,size,digest,expected)=>{const h=await files.hash(p);if(h.size!==size||h.sha256!==digest)throw Error('HASH_MISMATCH');const s=await files.stat(target);if(s.file){const old=await files.hash(target);if(old.sha256===digest)return {path:target};if(expected===null||expected!==undefined&&expected!==old.sha256)throw Error('file_target_changed');}await mkdir(dirname(path(target)),{recursive:true});await rename(path(p),path(target));return {path:target};},
  remove:async p=>{await rm(path(p),{force:true});},
 };
 const grants=new Map<string,{connectionId:string;epoch:number;readOnly:boolean}>();let peak=0,stageCalls=0;
 const native=async<T>(method:string,a:Row,bytes?:Uint8Array):Promise<T>=>{
  await options.fault?.(method,a);
  if(a.operation==='probe')return {version:1,methods:['file.resumable.stage','file.resumable.status','file.resumable.missing','file.resumable.finalize','file.resumable.release'],chunkBytes:65536,maxObjectBytes:16777216,maxInFlightObjects:options.maxObjects??4,maxStagingBytes:67108864,maxJournalBytes:16777216,durable:true,fencing:true,elapsedMillis:Math.floor(performance.now())} as T;
  const scope=String(a.scope),prior=grants.get(scope);if(a.operation==='collect'){await rm(path('native/'+scope),{recursive:true,force:true});grants.delete(scope);return {} as T;}if(a.operation==='acquire'){const epoch=(prior?.epoch??0)+1;grants.set(scope,{connectionId:String(a.connectionId),epoch,readOnly:a.readOnly===true});return {epoch} as T;}
  if(!prior||prior.epoch!==a.epoch||prior.connectionId!==a.connectionId)throw Error('STALE_EPOCH');
  if(a.operation==='check')return {} as T;if(a.operation==='readOnly'){prior.readOnly=true;return {} as T;}
  const d=a.object as VerifiedObject;const dir='native/'+scope+'/'+d.id;
  const missing=async()=>{const ns:number[]=[];for(let i=0;i<d.chunkHashes.length;i++){try{const b=await readFile(path(dir+'/'+i));if(hash(b)!==d.chunkHashes[i])ns.push(i);}catch{ns.push(i);}}return ns;};
  const status=async()=>{const ns=await missing();return {state:ns.length===d.chunkHashes.length?'PENDING':'PARTIAL',missing:ns};};
  if(a.operation==='object'||method.endsWith('.missing'))return await status() as T;
  if(method.endsWith('.release')){await rm(path(dir),{force:true,recursive:true});return {} as T;}
  if(prior.readOnly)throw Error('JOB_CANCELLED');
  if(method.endsWith('.stage')){if(!bytes)throw Error('B2_BASE64_FORBIDDEN');stageCalls++;peak=Math.max(peak,bytes.length);if(hash(bytes)!==d.chunkHashes[Number(a.index)])throw Error('HASH_MISMATCH');await durable(dir+'/'+a.index,bytes);return await status() as T;}
  if(method.endsWith('.finalize')){if((await missing()).length)throw Error('CHUNKS_MISSING');const temp=dir+'/compose';await files.writeBytes(temp,new Uint8Array());for(let i=0;i<d.chunkHashes.length;i++){const b=await readFile(path(dir+'/'+i));await files.appendBytes(temp,b,i*65536);}const target=String(a.path);try{await files.commit(temp,target,d.size,d.sha256,null);}catch(e){if(String(e).includes('file_target_changed'))throw Error('PUBLICATION_CONFLICT');throw e;}return {path:target,size:d.size,sha256:d.sha256} as T;}
  throw Error('bad native method '+method);
 };
 const chunks=new VerifiedChunkStore((m,a)=>native(m,a),(m,a,b)=>native(m,a,b));const store=new BinaryStore(db);
 const kv=new Map<string,string>();const account=new WatchAccountStore({get:k=>kv.get(k)??null,set:(k,v)=>{kv.set(k,v);},remove:k=>{kv.delete(k);}});
 // Synthetic account only. No production tokens or keys.
 kv.set('state_json',JSON.stringify({userId:'b2-host',watchDeviceToken:'fixture',backendBaseUrl:'https://fixture.invalid'}));
 const accountScope=D('wrss.library-resume.v1/account',['https://fixture.invalid','b2-host']);
 const ports:BinaryApplicationPorts={b2Enabled:options.enabled??true,byteBridge:()=>true,localPermission:()=>true,store,chunks,files,account,deviceId:async()=>'watch',randomId:async()=>nonce(),now:()=>performance.now(),sleep};
 const service=new BinaryApplicationService(ports);
 const repository={deviceId:async()=>'watch',configurePeer:()=>{}} as unknown as LibrarySessionRepository;
 function session(){
  const pair=bytePair(),operation=<T>(value:Promise<T>|T)=>({result:Promise.resolve(value),cancel:()=>{void pair.close();}});
  const radio={status:async()=>({permission:'granted',available:true,enabled:true}),listen:()=>operation({id:'listener'}),accept:()=>operation({id:'stream',remoteName:'host',remoteAddress:'host'}),close:async()=>{}} as unknown as RfcommPorts['radio'];
  const streams={read:()=>{throw Error('B2_BASE64_FORBIDDEN');},write:()=>{throw Error('B2_BASE64_FORBIDDEN');},readBytes:(_id:string,max:number)=>operation(pair.watch.read(max,3000).then(b=>({eof:b===null,bytes:b??new Uint8Array()}))),writeBytes:(_id:string,b:Uint8Array)=>operation(pair.watch.write(b).then(()=>({written:b.length}))),close:async()=>pair.close()} as unknown as RfcommPorts['streams'];
  const owner=new RfcommLibraryListener(repository,{radio,streams}),connection=new StreamFrameConnection(pair.phone),running=owner.start({binary:service,filterRequest:foregroundRequestFilter,handleAction:async r=>({success:true,action:r.action,version:1}),now:()=>0});void running.catch(()=>{});return {pair,connection,owner,running};
 }

 return {root,sql,db,files,store,chunks,ports,service,accountScope,session,stats:()=>({stageCalls,peak}),dispose:async()=>{sql.close();await rm(root,{recursive:true,force:true});}};
}
