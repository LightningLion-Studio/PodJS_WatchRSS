import {Database} from 'bun:sqlite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {VerifiedChunkStore,type ChunkHost,type VerifiedObject} from '@podjs/framework/verified-chunk-store';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {encodeBodyJson} from '../../src/sync/article-body';
import {LibraryResumeConnection,type ResumePorts} from '../../src/sync/library-resume/coordinator';
import {ResumeStore} from '../../src/sync/library-resume/store';
import {applyResumeObject} from '../../src/sync/library-resume/repository';
import {D,requestDigest,offerDigest,preparationDigest,selectionDigest,planDigest} from '../../src/sync/library-resume/digests';
import {ResumeError,HARD_LIMITS,CHUNK_BYTES,hash,type Row,type Envelope,type ObjectDescriptor,type Capability,type Selection,type BeginPayload,type Binding,type Snapshot} from '../../src/sync/library-resume/wire';
import vectors from '../fixtures/library-resume-v1.json';
import type {SyncFrameConnection} from '../../src/sync/session';
import type {BoundLocalTransferIntake,LocalTransferWrite} from '../../src/sync-v2/local-transfer-intake';
export {vectors};
export const nonce=()=>randomBytes(16).toString('hex');
class Queue {
 values:(Row|Error)[]=[];waiters:{resolve:(r:Row)=>void;reject:(e:Error)=>void}[]=[];
 push(v:Row|Error){const w=this.waiters.shift();if(w){if(v instanceof Error)w.reject(v);else w.resolve(v);}else this.values.push(v);}
 read(){const v=this.values.shift();if(v)return v instanceof Error?Promise.reject(v):Promise.resolve(v);return new Promise<Row>((resolve,reject)=>this.waiters.push({resolve,reject}));}
}
export function frames(){
 const a=new Queue(),b=new Queue();let closed=false;
 const close=async()=>{if(!closed){closed=true;a.push(Error('EOF'));b.push(Error('EOF'));}};
 const copy=(r:Row)=>JSON.parse(JSON.stringify(r));
 const phone:SyncFrameConnection={readFrame:()=>a.read(),writeFrame:async r=>{if(closed)throw Error('EOF');b.push(copy(r));},close};
 const watch:SyncFrameConnection={readFrame:()=>b.read(),writeFrame:async r=>{if(closed)throw Error('EOF');a.push(copy(r));},close};
 return {phone,watch,close};
}
export class NativeFixture {
 scopes=new Map<string,{connectionId:string;epoch:number;readOnly:boolean}>();
 objects=new Map<string,{descriptor:VerifiedObject;chunks:Map<number,Uint8Array>;complete?:Uint8Array}>();
 files=new Map<string,Uint8Array>();requests=new Map<string,string>();stages=0;peak=0;
 host:ChunkHost=async<T>(method:string,a:Row)=>{
  a.requestId=123; // PodServices reserves this field for the host request ID.
  const result=await this.execute(method,a);return result as T;
 };
 private async execute(method:string,a:Row):Promise<Row>{
  if(a.operation==='probe')return {version:1,methods:['file.resumable.stage','file.resumable.status','file.resumable.missing','file.resumable.finalize','file.resumable.release'],chunkBytes:65536,maxObjectBytes:16777216,maxInFlightObjects:4,maxStagingBytes:134217728,maxJournalBytes:16777216,durable:true,fencing:true,elapsedMillis:1000};
  const scope=String(a.scope),old=this.scopes.get(scope);
  if(a.operation==='acquire'){const epoch=old?.connectionId===a.connectionId?old!.epoch:(old?.epoch??0)+1;this.scopes.set(scope,{connectionId:String(a.connectionId),epoch,readOnly:a.readOnly===true});return {epoch};}
  if(!old||old.connectionId!==a.connectionId||old.epoch!==a.epoch)throw new ResumeError('STALE_EPOCH');
  if(a.operation==='readOnly'){old.readOnly=true;return {};}
  if(a.operation==='check')return {};
  const d=a.object as unknown as VerifiedObject,key=scope+'/'+d.id,entry=this.objects.get(key),path=typeof a.path==='string'?a.path:'resumable-published/'+key+'.bin';
  if(entry&&JSON.stringify(entry.descriptor)!==JSON.stringify(d))throw new ResumeError('OBJECT_CONFLICT');
  if(method.endsWith('.release')){this.objects.delete(key);if(a.discardPublication)this.files.delete(path);return {released:true};}
  const missing=()=>{if(entry?.complete&&hash(entry.complete)===d.sha256)return [];return d.chunkHashes.flatMap((h,i)=>{const b=entry?.chunks.get(i);return b&&hash(b)===h?[]:[i];});};
  if(method.endsWith('.missing')||a.operation==='object'){const absent=missing();return {missing:absent,state:entry?.complete&&hash(entry.complete)===d.sha256?'STAGED':absent.length===d.chunkHashes.length?'PENDING':'PARTIAL'};}
  if(old.readOnly)throw new ResumeError('JOB_CANCELLED');
  let current=entry;if(!current){if(this.objects.size>=4)throw new ResumeError('WINDOW_FULL');current={descriptor:d,chunks:new Map()};this.objects.set(key,current);this.peak=Math.max(this.peak,this.objects.size);}
  if(method.endsWith('.stage')){const bytes=new Uint8Array(Buffer.from(String(a.dataBase64),'base64')),index=Number(a.index);if(hash(bytes)!==d.chunkHashes[index])throw new ResumeError('HASH_MISMATCH');const rk=scope+'/'+a.bindingId,prior=this.requests.get(rk);if(prior&&prior!==a.requestDigest)throw new ResumeError('REQUEST_CONFLICT');this.requests.set(rk,String(a.requestDigest));if(!current.chunks.has(index))this.stages++;current.chunks.set(index,bytes);return {state:'PARTIAL',missing:[]};}
  if(method.endsWith('.finalize')){if(this.files.has(path)&&hash(this.files.get(path)!)!==d.sha256)return {error:'PUBLICATION_CONFLICT'};if(current.complete&&hash(current.complete)===d.sha256){this.files.set(path,current.complete);return {path,size:d.size,sha256:d.sha256};}const parts=d.chunkHashes.map((h,i)=>{const bytes=current!.chunks.get(i);if(!bytes||hash(bytes)!==h)throw new ResumeError('CHUNKS_MISSING');return bytes;});const bytes=new Uint8Array(Buffer.concat(parts));if(bytes.length!==d.size||hash(bytes)!==d.sha256)throw new ResumeError('HASH_MISMATCH');current.complete=bytes;this.files.set(path,bytes);return {path,size:d.size,sha256:d.sha256};}
  throw Error('Unsupported fixture host '+method);
 }
}
export async function fixture(){
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as Row[],execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[]);})();},transactionChanges:async statements=>sql.transaction(()=>statements.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return Number((sql.query('SELECT changes() AS n').get() as Row).n);} ))()};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice(vectors.watchDeviceId);
 const native=new NativeFixture(),chunks=new VerifiedChunkStore(native.host),store=new ResumeStore(db,()=>1000);
 const parseUri=async(value:string)=>{try{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}catch{return {valid:false,scheme:null,host:null,rawPath:null,rawQuery:null};}};
 const repository=new SqlLibrarySessionRepository(db,{codec:{sha256:async b=>hash(b),encode:async b=>new Uint8Array(gzipSync(Buffer.from(encodeBodyJson(b)))),decode:async b=>gunzipSync(b).toString()},files:{storeText:async(_k,v)=>v,hydrate:async v=>v},text:{parseUri,htmlText:async html=>html.replace(/<[^>]+>/g,'')},uri:{parseUri,parseAndroid:parseUri},migrateReading:async()=>{},cleanupRemovedContent:async()=>{}});
 const cap:Capability={version:1,kinds:[{kind:'articleBody',schemaVersion:1,send:true,receive:true},{kind:'articleMetadata',schemaVersion:1,send:true,receive:true},{kind:'rssSource',schemaVersion:1,send:true,receive:true}],limits:{...HARD_LIMITS}};
 const connect=(options:{drop?:string;source?:ResumePorts['source'];receive?:(frame:Row)=>Row;intake?:BoundLocalTransferIntake}={})=>{
  const pair=frames();if(options.receive){const read=pair.watch.readFrame.bind(pair.watch);pair.watch.readFrame=async timeout=>options.receive!(await read(timeout));}let dropped=false;const original=pair.watch.writeFrame.bind(pair.watch);pair.watch.writeFrame=async frame=>{if(!dropped&&frame.type==='response'&&frame.success&&frame.phase===options.drop){dropped=true;await pair.close();throw Error('reply lost');}return original(frame);};
  const ports:ResumePorts={store,chunks,capability:cap,accountScope:vectors.accountScope,phoneDeviceId:vectors.phoneDeviceId,watchDeviceId:vectors.watchDeviceId,connectionId:nonce(),authorize:async run=>run(),check:()=>{},sleep:ms=>{let timer:ReturnType<typeof setTimeout>;return {result:new Promise<void>(resolve=>{timer=setTimeout(resolve,ms);}),cancel:()=>clearTimeout(timer!)};},randomId:async()=>nonce(),freeze:async()=>({witness:vectors.watchSnapshot,inventory:{}}),source:options.source??(async()=>({objects:[],read:async()=>new Uint8Array()})),apply:(j,d,path,b)=>applyResumeObject(repository,{read:async(path,size)=>{const v=native.files.get(path);if(!v||v.length!==size)throw Error('LOCAL_IO');return v;}},j,d,path,b),supportsRange:async()=>true};
  if(options.intake)ports.apply=(j,d,path,b)=>{
   const apply=(check:LocalTransferWrite)=>applyResumeObject(repository,{read:async(path,size)=>{const v=native.files.get(path);if(!v||v.length!==size)throw Error('LOCAL_IO');return v;}},j,d,path,b,check);
   return options.intake!(apply);
  };
  const server=new LibraryResumeConnection(ports,pair.watch),errors:unknown[]=[];const running=pair.watch.readFrame(120000).then(first=>server.run(first)).catch(e=>{errors.push(e);});const phone=new Peer(pair.phone,cap);
  return {phone,server,pair,running,errors,ports};
 };
 return {db,sql,native,chunks,store,repository,cap,connect};
}
export class Peer {
 readonly jobId=vectors.bindings[0]!.jobId;plan=vectors.planDigest;epoch=1;
 constructor(readonly connection:SyncFrameConnection,readonly watchCapability:Capability){}
 async request(phase:Envelope['phase'],payload:Row,options:{id?:string;jobId?:string|null;plan?:string|null;epoch?:number|null}={}):Promise<Envelope>{const job=phase==='prepare'?null:options.jobId===undefined?this.jobId:options.jobId,plan=phase==='prepare'?null:options.plan===undefined?this.plan:options.plan,r:Envelope={action:'syncLibraryResume',version:1,phase,type:'request',jobId:job,requestId:options.id??nonce(),requestDigest:requestDigest(job,plan,phase,payload),epoch:phase==='prepare'||phase==='begin'?null:options.epoch??this.epoch,planDigest:plan,payload};await this.connection.writeFrame(r as unknown as Row);const answer=await this.connection.readFrame(120000) as unknown as Envelope;if(answer.requestId!==r.requestId)throw Error('Unexpected peer frame');return answer;}
 async prepare(intent:'create'|'resume'='create',bindings?:Binding[]){const payload={step:'offer',accountScope:vectors.accountScope,phoneDeviceId:vectors.phoneDeviceId,watchDeviceId:vectors.watchDeviceId,phoneCapabilities:vectors.capability,phoneSnapshot:vectors.phoneSnapshot,watchSnapshot:intent==='resume'?vectors.watchSnapshot:null};
  const offered=await this.request('prepare',payload);if(!offered.success)throw Error(JSON.stringify(offered));const digest=offerDigest(payload,this.watchCapability,vectors.watchSnapshot);if(offered.result?.offerDigest!==digest)throw Error('offer digest');
  const bs=bindings??[{direction:'phoneToWatch',jobId:this.jobId,intent,selection:vectors.selection as Selection}],confirmed=await this.request('prepare',{step:'confirm',offerRequestId:offered.requestId,bindings:bs,preparationDigest:preparationDigest(digest,bs)});if(!confirmed.success)throw Error(JSON.stringify(confirmed));
 }
 async begin(intent:'create'|'resume'='create'){const p={...(vectors.requests.find(v=>v.name==='begin')!.frame.payload as unknown as BeginPayload),intent};this.plan=planDigest(p);const result=await this.request('begin',p as unknown as Row);if(!result.success)throw Error(JSON.stringify(result));this.epoch=result.epoch!;return result;}
 async manifest(){return this.request('manifestPage',vectors.requests.find(v=>v.name==='manifest')!.frame.payload as unknown as Row);}
 async missing(limit=16){return this.request('missing',{afterObjectId:null,afterChunkIndex:null,limit});}
 async put(index:number,id?:string,bytes?:Uint8Array){const object=vectors.objects.find(v=>v.kind==='articleBody')!,body=new Uint8Array(Buffer.from(vectors.bodyBase64,'base64'));return this.request('putChunk',{objectId:object.objectId,chunkIndex:index,dataBase64:Buffer.from(bytes??body.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES)).toString('base64')},{id});}
 async stage(){const body=vectors.objects.find(v=>v.kind==='articleBody')!;for(let i=0;i<body.chunkHashes.length;i++){const r=await this.put(i);if(!r.success)throw Error(JSON.stringify(r));}}
 async apply(id=vectors.objects.find(v=>v.kind==='articleBody')!.objectId){return this.request('apply',{objectId:id});}
}
