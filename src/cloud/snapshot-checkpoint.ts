import {recordFailureDiagnostic} from './record-diagnostic';
import type {CloudSession} from './service';
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
export interface ProjectionIndex {length:number;parts:string[];lengths:number[];}
interface Journal {version:1;scope:string;cycle:number;active:boolean;phase:'snapshots'|'inventory'|'records';units:Record<string,number>;projections:Record<string,number>;work:number;bytes:number;}
export interface SnapshotMetric {event:'snapshot-work';stage:'download'|'chunk'|'object'|'overlay'|'apply'|'inventory'|'checkpoint-read'|'checkpoint-write'|'manifest'|'source-hash'|'decrypt'|'inflate'|'plan'|'checkpoint-invalid'|'export'|'checkpoint-range-piece';outcome?:'complete'|'failed';code?:string;objectIndex?:number;chunkIndex?:number;objects?:number;chunks?:number;maxChunkBytes?:number;bytes:number;durationMillis:number;cached:boolean;completedUnits:number;}
const validMap=(v:unknown):v is Record<string,number>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length<=200000&&Object.entries(v).every(([k,n])=>k.length<=512&&Number.isSafeInteger(n)&&n>=0);
/** Secure metadata + authenticated encrypted local projections. No cloud ACK is
 * derived from a downloaded/decrypted chunk: only committed SQL units count. */
export class SnapshotRestoreCheckpoint {
 private shards=Array.from({length:64},()=>({units:{} as Record<string,number>,projections:{} as Record<string,number>}));
 private rangeParts=new Map<string,Uint8Array>();private rangeBytes=0;
 private value!:Journal;private key?:Uint8Array;private startWork=0;private root='';private committedUnits=0;
 private get state(){return this.session.restoreCheckpoint?.state??this.session.state;}
 private get cache(){return this.session.restoreCheckpoint?.cache??this.session.cache;}
 private get codec(){return this.session.restoreCheckpoint?.codec??this.session.codec;}
 constructor(private session:CloudSession,private hash:(b:Uint8Array)=>Promise<string>,private current:()=>Promise<void>,private now:()=>number,private report?:(m:SnapshotMetric)=>void){}
 async open(epoch:string,generation:string){
  try{this.root=await this.hash(utf8Encode(JSON.stringify([SNAPSHOT_RESTORE_VERSION,await this.cache.scope(this.session.userId),epoch,generation,this.session.userId,this.session.deviceId])));
  const raw=await this.state.restoreJournal();let saved:Journal|undefined;try{saved=raw?JSON.parse(raw):undefined;}catch{}
  this.value=saved?.version===1&&saved.scope===this.root&&Number.isSafeInteger(saved.cycle)&&saved.cycle>=0&&typeof saved.active==='boolean'&&['snapshots','inventory','records'].includes(saved.phase)&&Number.isSafeInteger(saved.work)&&saved.work>=0&&Number.isSafeInteger(saved.bytes)&&saved.bytes>=0?saved:{version:1,scope:this.root,cycle:0,active:false,phase:'snapshots',units:{},projections:{},work:0,bytes:0};
  this.value.units={};this.value.projections={};
  for(let i=0;i<64;i++){const raw=await this.state.restoreJournal(i);if(!raw)continue;let shard:{scope:string;units:Record<string,number>;projections:Record<string,number>};try{shard=JSON.parse(raw);}catch{throw Error('cloud_snapshot_checkpoint_invalid');}if(shard.scope!==this.root)continue;if(!validMap(shard.units)||!validMap(shard.projections))throw Error('cloud_snapshot_checkpoint_invalid');this.shards[i]={units:shard.units,projections:shard.projections};Object.assign(this.value.units,shard.units);Object.assign(this.value.projections,shard.projections);}
  this.startWork=this.value.work;await this.accountKey();return this;}catch(error){if(this.value?.active&&String(error).includes('cloud_sync_deadline_exceeded'))throw Object.assign(Error('cloud_snapshot_progress_stalled'),{code:'cloud_snapshot_progress_stalled'});throw error;}
 }
 get cycle(){return this.value.cycle;}
 get active(){return this.value.active;}
 get phase(){return this.value.phase;}
 get work(){return this.value.work;}
 get advanced(){return this.value.work>this.startWork;}
 get committed(){return this.committedUnits>0;}
 private async save(){const {units,projections,...header}=this.value;await this.state.storeRestoreJournal(JSON.stringify(header));}
 private shard(key:string){let h=2166136261;for(let i=0;i<key.length;i++)h=Math.imul(h^key.charCodeAt(i),16777619);return (h>>>0)%64;}
 private async saveEntry(kind:'units'|'projections',key:string,value:number){const shard=this.shard(key);this.shards[shard][kind][key]=value;await this.state.storeRestoreJournal(JSON.stringify({scope:this.root,...this.shards[shard]}),shard);}

 async begin(){const dirty=new Set<number>();for(const unit of Object.keys(this.value.units))if(unit.startsWith('inventory:')){delete this.value.units[unit];const shard=this.shard(unit);delete this.shards[shard].units[unit];dirty.add(shard);}for(const shard of dirty)await this.state.storeRestoreJournal(JSON.stringify({scope:this.root,...this.shards[shard]}),shard);this.value.cycle++;this.value.work++;this.value.active=true;this.value.phase='snapshots';await this.save();}
 async phaseDone(phase:Journal['phase']){if(this.value.phase===phase)return;this.value.phase=phase;this.value.work++;await this.save();}
 async finish(){this.value.active=false;this.value.work++;await this.save();}
 has(unit:string){return Object.prototype.hasOwnProperty.call(this.value.units,unit);}
 async commit(unit:string,bytes=0){if(this.has(unit))return;this.value.units[unit]=bytes;this.value.work++;this.value.bytes+=bytes;await this.saveEntry('units',unit,bytes);this.committedUnits++;await this.save();}
 apply(prefix:string,progress?:(done:number,total:number)=>void):RestoreApplyCheckpoint{return {progress,has:unit=>this.has(prefix+':'+unit),result:unit=>this.value.units[prefix+':'+unit]??0,commit:(unit,abandoned=0)=>this.commit(prefix+':'+unit,abandoned),check:this.current};}
 metric(stage:SnapshotMetric['stage'],bytes:number,started:number,cached=false,details:Partial<Pick<SnapshotMetric,'outcome'|'code'|'objectIndex'|'chunkIndex'|'objects'|'chunks'|'maxChunkBytes'>>={}){try{this.report?.({event:'snapshot-work',stage,bytes,durationMillis:Math.max(0,this.now()-started),cached,completedUnits:this.value.work,...details});}catch{}}
 async timed<T>(stage:SnapshotMetric['stage'],bytes:number,run:()=>Promise<T>,cached=false){const at=this.now();let success=false,code:string|undefined;try{const value=await run();success=true;return value;}catch(error){const classified=JSON.parse(recordFailureDiagnostic(error)).code;code=classified==='unclassified'?'cloud_snapshot_'+stage.replace(/-/g,'_')+'_failed':classified;throw error;}finally{this.metric(stage,bytes,at,cached,{outcome:success?'complete':'failed',...(code?{code}:{})});}}
 async token(value:string){return this.hash(utf8Encode(this.root+':'+value));}
 private async accountKey(){return this.key??=await this.session.keys.accountKey(this.session.userId,await this.session.keys.currentKeyVersion(this.session.userId));}
 private async readBlob(id:string){await this.session.restoreCheckpoint?.assertCurrent?.();const key=await this.accountKey();if(!key)throw Error('missing_key_version');const bytes=await this.cache.restoreProjection(this.session.userId,id);if(!bytes)return;try{return await this.codec.openRestoreProjection(key,this.root+':'+id,bytes);}catch(error){await this.current();if(String(error).includes(CLOUD_SYNC_SUSPENDED))throw error;this.metric('checkpoint-invalid',bytes.length,this.now(),true,{outcome:'failed'});return;}}
 private async writeBlob(id:string,bytes:Uint8Array){await this.session.restoreCheckpoint?.assertCurrent?.();const key=await this.accountKey();if(!key)throw Error('missing_key_version');await this.cache.storeRestoreProjection(this.session.userId,id,await this.codec.sealRestoreProjection(key,this.root+':'+id,bytes));}
 /** Split the disposable decoded representation so a large old object also
  * checkpoints its assembly. Only complete AEAD-authenticated parts are reused. */
 async index(token:string):Promise<ProjectionIndex|undefined>{const raw=await this.readBlob(token);if(!raw)return;try{const m=JSON.parse(utf8Decode(raw));if(!Number.isSafeInteger(m.length)||m.length<0||m.length>256*1024*1024||!Array.isArray(m.parts)||m.parts.length>1024||m.parts.some((p:unknown)=>typeof p!=='string'||!/^[a-f0-9]{64}(?:-[A-Za-z0-9-]{1,160})?$/.test(p))||!Array.isArray(m.lengths)||m.lengths.length!==m.parts.length||m.lengths.some((n:unknown)=>!Number.isSafeInteger(n)||Number(n)<0||Number(n)>256*1024)||m.lengths.reduce((n:number,x:number)=>n+x,0)!==m.length)return;return m;}catch{return;}}
 async read(token:string):Promise<Uint8Array|undefined>{
  await this.current();const at=this.now(),m=await this.index(token);if(!m)return;const out=new Uint8Array(m.length);let offset=0;
  for(let i=0;i<m.parts.length;i++){await this.current();const b=await this.readBlob(m.parts[i]);if(!b||b.length!==m.lengths[i])return;out.set(b,offset);offset+=b.length;}this.metric('checkpoint-read',out.length,at,true);return out;
 }
 async link(token:string,children:string[],length:number){const parts:string[]=[],lengths:number[]=[];for(const child of children){await this.current();const m=await this.index(child);if(!m)throw Error('cloud_snapshot_projection_missing');parts.push(...m.parts);lengths.push(...m.lengths);}if(lengths.reduce((n,x)=>n+x,0)!==length||parts.length>1024)throw Error('cloud_snapshot_checkpoint_invalid');await this.writeBlob(token,utf8Encode(JSON.stringify({length,parts,lengths})));await this.commit('decoded:'+token,length);}
 async invalidate(unit:string){delete this.value.units[unit];const i=this.shard(unit);delete this.shards[i].units[unit];await this.state.storeRestoreJournal(JSON.stringify({scope:this.root,...this.shards[i]}),i);}
 async range(token:string,offset:number,length:number,index?:ProjectionIndex){await this.current();const m=index??await this.index(token);if(!m||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>m.length)throw Error('cloud_snapshot_projection_missing');const out=new Uint8Array(length);let start=0,at=0;
  for(let i=0;i<m.parts.length&&at<length;i++){const end=start+m.lengths[i];if(end>offset&&start<offset+length){await this.current();const id=m.parts[i];let b=this.rangeParts.get(id);if(!b){const began=this.now();b=await this.readBlob(id);if(!b||b.length!==m.lengths[i])throw Error('cloud_snapshot_projection_missing');while(this.rangeParts.size&&this.rangeBytes+b.length>8*1024*1024){const first=this.rangeParts.keys().next().value!;this.rangeBytes-=this.rangeParts.get(first)!.length;this.rangeParts.delete(first);}this.rangeParts.set(id,b);this.rangeBytes+=b.length;this.metric('checkpoint-range-piece',b.length,began,true);}else{this.rangeParts.delete(id);this.rangeParts.set(id,b);}const from=Math.max(0,offset-start),to=Math.min(b.length,offset+length-start);out.set(b.subarray(from,to),at);at+=to-from;}start=end;}if(at!==length)throw Error('cloud_snapshot_projection_missing');return out;
 }
 async write(token:string,bytes:Uint8Array){
  const began=this.now(),parts:string[]=[];for(let offset=0;offset<bytes.length||!parts.length;offset+=256*1024)parts.push(token+'-p'+offset);
  // Publish authenticated shape first. A partially written projection is never
  // readable; if the final part lands before a crash, no source AEAD repeats.
  await this.writeBlob(token,utf8Encode(JSON.stringify({length:bytes.length,parts,lengths:parts.map((_,i)=>Math.min(256*1024,bytes.length-i*256*1024))})));
  for(let offset=0,index=0;index<parts.length;offset+=256*1024,index++){const part=bytes.subarray(offset,offset+256*1024),id=parts[index];
   if(!Object.prototype.hasOwnProperty.call(this.value.projections,id)||!await this.readBlob(id)){await this.writeBlob(id,part);this.value.projections[id]=part.length;this.value.work++;this.value.bytes+=part.length;await this.saveEntry('projections',id,part.length);await this.save();}if(bytes.length>8*1024*1024&&index+1<parts.length)await this.current();
  }
  await this.commit('decoded:'+token,bytes.length);this.metric('checkpoint-write',bytes.length,began);
 }
 close(){for(const b of this.rangeParts.values())b.fill(0);this.rangeParts.clear();this.rangeBytes=0;if(this.key)this.codec.clearRestoreProjectionKey(this.key);this.key?.fill(0);this.key=undefined;}
 noProgress(error:unknown){if(this.value.active&&!this.advanced&&String(error).includes('cloud_sync_deadline_exceeded'))return Object.assign(Error('cloud_snapshot_progress_stalled'),{code:'cloud_snapshot_progress_stalled'});return error;}
}
