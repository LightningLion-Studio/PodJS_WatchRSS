import {restoreReceiptClass} from './restore-callsite';
import {cpuWork,cpuJsonParse,cpuJsonStringify} from '@podjs/framework/cpu-work';
import {snapshotDeferred,SNAPSHOT_GUARD_VERSION} from './snapshot-deferral';
import {recordFailureDiagnostic} from './record-diagnostic';
import type {CloudSession} from './service';
import {bytesToBase64} from '@podjs/framework/bytes';
import {utf8Encode,utf8Decode} from './types';
import {CLOUD_SYNC_SUSPENDED} from './execution';

/** Bump when projection/application semantics change, never the cloud format. */
export const SNAPSHOT_RESTORE_VERSION=1;
export interface RestoreApplyCheckpoint {
 has(unit:string):boolean;
 commit(unit:string,abandoned?:number):Promise<void>;
 result(unit:string):number;
 progress?(done:number,total:number):void;
 check():Promise<void>;
}
export interface ProjectionIndex {provisional?:boolean;length:number;parts:string[];lengths:number[];}
interface Journal {version:1;scope:string;cycle:number;active:boolean;phase:'snapshots'|'inventory'|'records';units:Record<string,number>;projections:Record<string,number>;work:number;bytes:number;}
export interface SnapshotMetric {event:'snapshot-work';stage:'download'|'chunk'|'object'|'overlay'|'apply'|'inventory'|'checkpoint-read'|'checkpoint-write'|'manifest'|'source-hash'|'decrypt'|'inflate'|'plan'|'checkpoint-invalid'|'export'|'checkpoint-range-piece';outcome?:'complete'|'failed'|'deferred';code?:string;objectIndex?:number;chunkIndex?:number;objects?:number;chunks?:number;maxChunkBytes?:number;bytes:number;durationMillis:number;cached:boolean;completedUnits:number;}
const validMap=(v:unknown):v is Record<string,number>=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const keys=Object.keys(v);return cpuWork('projection-rebuild','items',keys.length,()=>keys.length<=200000&&Object.entries(v).every(([k,n])=>k.length<=512&&Number.isSafeInteger(n)&&n>=0));};
/** Secure metadata + authenticated encrypted local projections. No cloud ACK is
 * derived from a downloaded/decrypted chunk: only committed SQL units count. */
export class SnapshotRestoreCheckpoint {
 private shards=Array.from({length:64},()=>({units:{} as Record<string,number>,projections:{} as Record<string,number>}));
 private indices=new Map<string,ProjectionIndex>();
 private rangeParts=new Map<string,Uint8Array>();private rangeBytes=0;
 private value!:Journal;private key?:Uint8Array;private startWork=0;private root='';private committedUnits=0;
 private get guardVersion(){return this.session.restoreCheckpoint?.guardVersion??SNAPSHOT_GUARD_VERSION;}
 private get state(){return this.session.restoreCheckpoint?.state??this.session.state;}
 private get cache(){return this.session.restoreCheckpoint?.cache??this.session.cache;}
 private get codec(){return this.session.restoreCheckpoint?.codec??this.session.codec;}
 constructor(private session:CloudSession,private hash:(b:Uint8Array)=>Promise<string>,private current:()=>Promise<void>,private now:()=>number,private report?:(m:SnapshotMetric)=>void){}
 private readBatch<T>(action:()=>Promise<T>){return this.session.restoreCheckpoint?.readBatch?.(action)??action();}
 async open(epoch:string,generation:string){return this.readBatch(()=>this.openJournal(epoch,generation));}
 private async openJournal(epoch:string,generation:string){
  try{this.root=await this.hash(utf8Encode(cpuJsonStringify([SNAPSHOT_RESTORE_VERSION,await this.cache.scope(this.session.userId),epoch,generation,this.session.userId,this.session.deviceId])));
  const raw=await this.state.restoreJournal();let saved:Journal|undefined;try{saved=raw?cpuJsonParse(raw):undefined;}catch{}
  this.value=saved?.version===1&&saved.scope===this.root&&Number.isSafeInteger(saved.cycle)&&saved.cycle>=0&&typeof saved.active==='boolean'&&['snapshots','inventory','records'].includes(saved.phase)&&Number.isSafeInteger(saved.work)&&saved.work>=0&&Number.isSafeInteger(saved.bytes)&&saved.bytes>=0?saved:{version:1,scope:this.root,cycle:0,active:false,phase:'snapshots',units:{},projections:{},work:0,bytes:0};
  this.value.units={};this.value.projections={};
  for(let i=0;i<64;i++){await this.current();const raw=await this.state.restoreJournal(i);if(!raw)continue;let shard:{scope:string;units:Record<string,number>;projections:Record<string,number>};try{shard=cpuJsonParse(raw);}catch{throw Error('cloud_snapshot_checkpoint_invalid');}if(shard.scope!==this.root)continue;if(!validMap(shard.units)||!validMap(shard.projections))throw Error('cloud_snapshot_checkpoint_invalid');this.shards[i]={units:shard.units,projections:shard.projections};Object.assign(this.value.units,shard.units);Object.assign(this.value.projections,shard.projections);}
  this.startWork=this.value.work;this.session.restoreCheckpoint?.stalled?.(this.value.active&&await this.state.restoreWindowStalled(this.root,this.value.work,this.guardVersion));await this.accountKey();return this;}catch(error){throw await this.noProgress(error);}
 }
 get cycle(){return this.value.cycle;}
 get active(){return this.value.active;}
 get phase(){return this.value.phase;}
 get work(){return this.value.work;}
 get advanced(){return this.value.work>this.startWork;}
 get committed(){return this.committedUnits>0;}
 private async save(){const {units,projections,...header}=this.value;await this.state.storeRestoreJournal(cpuJsonStringify(header));}
 private shard(key:string){let h=2166136261;for(let i=0;i<key.length;i++)h=Math.imul(h^key.charCodeAt(i),16777619);return (h>>>0)%64;}
 private async saveEntry(kind:'units'|'projections',key:string,value:number){const shard=this.shard(key);this.shards[shard][kind][key]=value;const {units,projections,...header}=this.value;if(this.state.storeRestoreJournalEntry)await this.state.storeRestoreJournalEntry(cpuJsonStringify(header),shard,cpuJsonStringify({scope:this.root,...this.shards[shard]}));else{await this.state.storeRestoreJournal(cpuJsonStringify({scope:this.root,...this.shards[shard]}),shard);await this.save();}}

 async begin(){const dirty=new Set<number>();for(const unit of Object.keys(this.value.units))if(unit.startsWith('inventory:')){delete this.value.units[unit];const shard=this.shard(unit);delete this.shards[shard].units[unit];dirty.add(shard);}for(const shard of dirty)await this.state.storeRestoreJournal(cpuJsonStringify({scope:this.root,...this.shards[shard]}),shard);this.value.cycle++;this.value.work++;this.value.active=true;this.value.phase='snapshots';await this.save();}
 async phaseDone(phase:Journal['phase']){if(this.value.phase===phase)return;this.value.phase=phase;this.value.work++;await this.save();}
 async finish(){this.value.active=false;this.value.work++;await this.save();await this.state.observeRestoreWindow(this.root,this.work,true,this.guardVersion);}
 has(unit:string){return Object.prototype.hasOwnProperty.call(this.value.units,unit);}
 private async record(kind:'units'|'projections',id:string,bytes:number){
  const work=this.value.work,total=this.value.bytes,previous=this.value[kind][id],shard=this.shard(id);
  this.value[kind][id]=bytes;this.value.work++;this.value.bytes+=bytes;
  try{await this.saveEntry(kind,id,bytes);this.committedUnits++;try{this.session.restoreCheckpoint?.receipt?.(restoreReceiptClass(kind,id));}catch{/* Diagnostic only. */}this.session.restoreCheckpoint?.stalled?.(false);}catch(error){if((error as {restoreEntryCommitted?:boolean})?.restoreEntryCommitted){this.committedUnits++;try{this.session.restoreCheckpoint?.receipt?.(restoreReceiptClass(kind,id));}catch{/* Diagnostic only. */}}this.value.work=work;this.value.bytes=total;if(previous===undefined){delete this.value[kind][id];delete this.shards[shard][kind][id];}else{this.value[kind][id]=previous;this.shards[shard][kind][id]=previous;}throw error;}
 }
 async commit(unit:string,bytes=0){if(this.has(unit))return;await this.record('units',unit,bytes);}
 apply(prefix:string,progress?:(done:number,total:number)=>void):RestoreApplyCheckpoint{return {progress,has:unit=>this.has(prefix+':'+unit),result:unit=>this.value.units[prefix+':'+unit]??0,commit:(unit,abandoned=0)=>this.commit(prefix+':'+unit,abandoned),check:this.current};}
 metric(stage:SnapshotMetric['stage'],bytes:number,started:number,cached=false,details:Partial<Pick<SnapshotMetric,'outcome'|'code'|'objectIndex'|'chunkIndex'|'objects'|'chunks'|'maxChunkBytes'>>={}){try{this.report?.({event:'snapshot-work',stage,bytes,durationMillis:Math.max(0,this.now()-started),cached,completedUnits:this.value.work,...details});}catch{}}
 async timed<T>(stage:SnapshotMetric['stage'],bytes:number,run:()=>Promise<T>,cached=false,details:Partial<Pick<SnapshotMetric,'objectIndex'|'chunkIndex'>>={}){const at=this.now();let success=false,code:string|undefined;try{const value=await run();success=true;return value;}catch(error){const classified=cpuJsonParse(recordFailureDiagnostic(error)).code;code=classified==='unclassified'?'cloud_snapshot_'+stage.replace(/-/g,'_')+'_failed':classified;throw error;}finally{this.metric(stage,bytes,at,cached,{...details,outcome:success?'complete':snapshotDeferred({code})||['cloud_sync_deadline_exceeded','cloud_snapshot_progress_stalled','cloud_sync_suspended'].includes(code??'')?'deferred':'failed',...(code?{code}:{})});}}
 async token(value:string){return this.hash(utf8Encode(this.root+':'+value));}
 private async accountKey(){return this.key??=await this.session.keys.accountKey(this.session.userId,await this.session.keys.currentKeyVersion(this.session.userId));}
 private async readBlob(id:string){await this.session.restoreCheckpoint?.assertCurrent?.();const key=await this.accountKey();if(!key)throw Error('missing_key_version');const bytes=await this.cache.restoreProjection(this.session.userId,id);if(!bytes)return;try{return await this.codec.openRestoreProjection(key,this.root+':'+id,bytes);}catch(error){await this.current();if(String(error).includes(CLOUD_SYNC_SUSPENDED))throw error;this.metric('checkpoint-invalid',bytes.length,this.now(),true,{outcome:'failed'});return;}}
 private async writeBlob(id:string,bytes:Uint8Array){this.indices.delete(id);await this.session.restoreCheckpoint?.assertCurrent?.();const key=await this.accountKey();if(!key)throw Error('missing_key_version');await this.cache.storeRestoreProjection(this.session.userId,id,await this.codec.sealRestoreProjection(key,this.root+':'+id,bytes));}
 /** Split the disposable decoded representation so a large old object also
  * checkpoints its assembly. Only complete AEAD-authenticated parts are reused. */
 async index(token:string):Promise<ProjectionIndex|undefined>{const cached=this.indices.get(token);if(cached)return cached;const raw=await this.readBlob(token);if(!raw)return;try{const m=cpuJsonParse(utf8Decode(raw));if(!Number.isSafeInteger(m.length)||m.length<0||m.length>256*1024*1024||!Array.isArray(m.parts)||m.parts.length>2048||m.parts.some((p:unknown)=>typeof p!=='string'||!/^[a-f0-9]{64}(?:-[A-Za-z0-9-]{1,160})?$/.test(p))||!Array.isArray(m.lengths)||m.lengths.length!==m.parts.length||m.lengths.some((n:unknown)=>!Number.isSafeInteger(n)||Number(n)<0||Number(n)>256*1024)||m.lengths.reduce((n:number,x:number)=>n+x,0)!==m.length)return;this.indices.set(token,m);return m;}catch{return;}}
 length(token:string){return this.has('decoded:'+token)?this.value.units['decoded:'+token]:undefined;}
 async read(token:string):Promise<Uint8Array|undefined>{return this.readBatch(()=>this.readProjection(token));}
 private async readProjection(token:string):Promise<Uint8Array|undefined>{
  await this.current();const at=this.now(),m=await this.index(token);if(!m){if(this.has('decoded:'+token))await this.invalidate('decoded:'+token);return;}if(m.provisional&&!this.has('decoded:'+token))return;// Partial shapes resume their suffix without decrypting the committed prefix.
  if(m.parts.length>1&&m.parts.some(id=>!Object.prototype.hasOwnProperty.call(this.value.projections,id)))return;
  if(m.length>256*1024&&m.length<=64*1024*1024&&this.codec.batchedRestoreParts){
   const key=await this.accountKey();if(!key)throw Error('missing_key_version');
   try{const out=await this.codec.openRestoreParts(key,await Promise.all(m.parts.map(async(id,i)=>({path:await this.cache.restoreProjectionPath(this.session.userId,id),scope:this.root+':'+id,bytes:m.lengths[i]}))),m.length);await this.current();this.metric('checkpoint-read',out.length,at,true);return out;}
   catch(error){await this.current();const match=/sealed_part_invalid_([0-9]+)/.exec(String(error));if(!match)throw error;const i=Number(match[1]);if(i<m.parts.length)await this.forgetProjection(m.parts[i]);return;}
  }
  const out=new Uint8Array(m.length);let offset=0;
  for(let i=0;i<m.parts.length;i++){await this.current();const b=await this.readBlob(m.parts[i]);if(!b||b.length!==m.lengths[i]){await this.forgetProjection(m.parts[i]);return;}out.set(b,offset);offset+=b.length;}this.metric('checkpoint-read',out.length,at,true);return out;
 }
 async link(token:string,children:string[],length:number):Promise<void>{return this.readBatch(()=>this.linkParts(token,children,length));}
 private async linkParts(token:string,children:string[],length:number){const parts:string[]=[],lengths:number[]=[];for(const child of children){await this.current();const m=await this.index(child);if(!m)throw Error('cloud_snapshot_projection_missing');parts.push(...m.parts);lengths.push(...m.lengths);}if(lengths.reduce((n,x)=>n+x,0)!==length||parts.length>2048)throw Error('cloud_snapshot_checkpoint_invalid');await this.writeBlob(token,utf8Encode(cpuJsonStringify({length,parts,lengths})));await this.commit('decoded:'+token,length);}
 async invalidate(unit:string){delete this.value.units[unit];const i=this.shard(unit);delete this.shards[i].units[unit];await this.state.storeRestoreJournal(cpuJsonStringify({scope:this.root,...this.shards[i]}),i);}
 async range(token:string,offset:number,length:number,index?:ProjectionIndex):Promise<Uint8Array>{return this.readBatch(()=>this.readRange(token,offset,length,index));}
 private async readRange(token:string,offset:number,length:number,index?:ProjectionIndex){await this.current();const m=index??await this.index(token);if(!m||m.provisional&&!this.has('decoded:'+token)||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>m.length)throw Error('cloud_snapshot_projection_missing');const out=new Uint8Array(length);let start=0,at=0;
  for(let i=0;i<m.parts.length&&at<length;i++){const end=start+m.lengths[i];if(end>offset&&start<offset+length){await this.current();const id=m.parts[i];let b=this.rangeParts.get(id);if(!b){const began=this.now();b=await this.readBlob(id);if(!b||b.length!==m.lengths[i]){await this.forgetProjection(id);throw Error('cloud_snapshot_projection_missing');}while(this.rangeParts.size&&this.rangeBytes+b.length>8*1024*1024){const first=this.rangeParts.keys().next().value!;this.rangeBytes-=this.rangeParts.get(first)!.length;this.rangeParts.delete(first);}this.rangeParts.set(id,b);this.rangeBytes+=b.length;this.metric('checkpoint-range-piece',b.length,began,true);}else{this.rangeParts.delete(id);this.rangeParts.set(id,b);}const from=Math.max(0,offset-start),to=Math.min(b.length,offset+length-start);out.set(b.subarray(from,to),at);at+=to-from;}start=end;}if(at!==length)throw Error('cloud_snapshot_projection_missing');return out;
 }
 private async forgetProjection(id:string){const token=id.replace(/-p[0-9]+$/,'');if(this.has('decoded:'+token))await this.invalidate('decoded:'+token);if(this.has('decoded:'+token+'-eof'))await this.invalidate('decoded:'+token+'-eof');delete this.value.projections[id];const shard=this.shard(id);delete this.shards[shard].projections[id];await this.state.storeRestoreJournal(cpuJsonStringify({scope:this.root,...this.shards[shard]}),shard);}
 async write(token:string,bytes:Uint8Array){
  const began=this.now(),parts:string[]=[];for(let offset=0;offset<bytes.length||!parts.length;offset+=256*1024)parts.push(token+'-p'+offset);
  // Publish authenticated shape first. A partially written projection is never
  // readable; if the final part lands before a crash, no source AEAD repeats.
  await this.writeBlob(token,utf8Encode(cpuJsonStringify({length:bytes.length,parts,lengths:parts.map((_,i)=>Math.min(256*1024,bytes.length-i*256*1024))})));
  // Each authenticated file + secure receipt is resumable. Never reread the
  // already committed prefix while assembling the next suffix.
  for(let offset=0,index=0;index<parts.length;offset+=256*1024,index++){if(index)await this.current();const part=bytes.subarray(offset,offset+256*1024),id=parts[index];
   if(!Object.prototype.hasOwnProperty.call(this.value.projections,id)){await this.writeBlob(id,part);await this.record('projections',id,part.length);}
  }
  await this.commit('decoded:'+token,bytes.length);this.metric('checkpoint-write',bytes.length,began);
 }
 /** Output parts are provisional until native EOF/CRC and optional content hash.
  * The scope binds immutable source descriptors. Old published state stays live. */
 async gunzip(token:string,children:string[],length:number,contentHash?:string,allowShortOutput=false){
  await this.current();const parts:{path:string;aadBase64:string;bytes:number}[]=[];let inputBytes=0;
  for(const child of children){const index=await this.index(child);if(!index||!this.has('decoded:'+child))throw Error('cloud_snapshot_projection_missing');
   for(let i=0;i<index.parts.length;i++){const id=index.parts[i];parts.push({path:await this.cache.restoreProjectionPath(this.session.userId,id),aadBase64:bytesToBase64(utf8Encode(this.root+':'+id)),bytes:index.lengths[i]});inputBytes+=index.lengths[i];}}
  const ids:string[]=[],lengths:number[]=[];for(let at=0;at<length||!ids.length;at+=262144){ids.push(token+'-p'+at);lengths.push(Math.min(262144,length-at));}
  // Legacy readers ignore unknown fields. An unreceipted zero-length member
  // keeps their all-parts check closed until EOF/CRC/content hash succeeds.
  const staged={provisional:true,length,parts:[...ids,token+'-pending'],lengths:[...lengths,0]};
  const existing=await this.index(token);if(!existing||cpuJsonStringify(existing)!==cpuJsonStringify(staged))await this.writeBlob(token,utf8Encode(cpuJsonStringify(staged)));
  let offset=0;for(let i=0;i<ids.length;i++){if(this.value.projections[ids[i]]!==lengths[i])break;offset+=lengths[i];}
  const key=await this.accountKey();if(!key)throw Error('missing_key_version');
  const prefix=(await this.cache.restoreProjectionPath(this.session.userId,token)).replace(/\.bin$/,'-p');
  let actualLength=length;
  const completed=this.length(token+'-eof');
  if(allowShortOutput&&completed!==undefined)actualLength=completed;
  else try{const hash=await this.codec.streamRestoreGzip(key,parts,inputBytes,prefix,this.root+':'+token+'-p',length,offset,async step=>{
    await this.session.restoreCheckpoint?.assertCurrent?.();if((step.bytes||length===0)&&!Object.prototype.hasOwnProperty.call(this.value.projections,token+'-p'+step.offset))await this.record('projections',token+'-p'+step.offset,step.bytes);
    if(allowShortOutput&&step.done){if(contentHash&&step.sha256!==contentHash)throw Error('cloud_snapshot_projection_integrity');actualLength=step.offset+step.bytes;await this.commit('decoded:'+token+'-eof',actualLength);}
    await this.current();
   },allowShortOutput);if(contentHash&&hash!==contentHash)throw Error('cloud_snapshot_projection_integrity');
  }catch(error){const match=/sealed_part_invalid_([0-9]+)/.exec(String(error));if(match){const id=parts[Number(match[1])]?.path.split('/').at(-1)?.replace(/\.bin$/,'');if(id)await this.forgetProjection(id);}throw error;}
  // Only verified output may replace the provisional shape. Both the old and
  // new readers can recover this valid publication if the final receipt stops.
  const finalIds=allowShortOutput?ids.filter((_,i)=>i*262144<actualLength):ids;
  await this.writeBlob(token,utf8Encode(cpuJsonStringify({length:actualLength,parts:finalIds,lengths:finalIds.map((_,i)=>Math.min(262144,actualLength-i*262144))})));
  await this.commit('decoded:'+token,actualLength);
 }
 close(){this.indices.clear();for(const b of this.rangeParts.values())b.fill(0);this.rangeParts.clear();this.rangeBytes=0;if(this.key)this.codec.clearRestoreProjectionKey(this.key);this.key?.fill(0);this.key=undefined;}
 async noProgress(error:unknown){
  if(!this.value?.active||!String(error).includes('cloud_sync_deadline_exceeded'))return error;
  let zeros=0;try{zeros=await this.state.observeRestoreWindow(this.root,this.work,this.committed,this.guardVersion);}catch{/* Keep the original retryable deadline if diagnostics cannot persist. */}
  if(zeros>=2){this.metric('object',0,this.now(),false,{outcome:'deferred',code:'cloud_snapshot_progress_stalled'});return Object.assign(Error('cloud_snapshot_progress_stalled'),{code:'cloud_snapshot_progress_stalled'});}
  return error;
 }
}
