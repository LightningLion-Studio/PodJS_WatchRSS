import type {CloudManifest,CloudObject} from './codec';

export interface RestorePhaseProgress {total:number;done:number;totalBytes:number;doneBytes:number;}
/** Logical work satisfied for a fixed, authenticated head set. Bytes are not
 * network traffic. Projection units are normalized 256 KiB output units, not
 * physical files or journal receipts. Partial/unverified gzip output is excluded. */
export interface RestoreProgress {
 version:1;ready:boolean;full:boolean;headsTotal:number;headsDone:number;
 download:RestorePhaseProgress;decompress:RestorePhaseProgress;
 apply:RestorePhaseProgress;projection:RestorePhaseProgress;
}
export interface RestoreProgressHead {manifest:CloudManifest;manifestHash:string;alreadyApplied:boolean;opaque?:boolean;objects:CloudObject[];}
interface Receipts {has(unit:string):boolean;length(token:string):number|undefined;}
const phase=():RestorePhaseProgress=>({total:0,done:0,totalBytes:0,doneBytes:0});
export const emptyRestoreProgress=(full=true):RestoreProgress=>({version:1,ready:false,full,headsTotal:0,headsDone:0,download:phase(),decompress:phase(),apply:phase(),projection:phase()});
interface Entry {object:CloudObject;token:string;head:number;apply:boolean;previous:number[];}
/** Denominators come exclusively from decrypted descriptors. Completion is
 * reconciled against existing v1 receipts without renaming or resetting them. */
export class RestoreProgressTracker {
 readonly state:RestoreProgress;
 private entries:Entry[]=[];private byToken=new Map<string,Entry>();
 private chunks=new Map<string,{bytes:number;done:boolean;users:{entry:Entry;index:number}[]}>();
 constructor(private receipts:Receipts,private heads:RestoreProgressHead[],full:boolean,private acknowledged:readonly string[]=[]){
  this.state={...emptyRestoreProgress(full),ready:heads.every(h=>!h.opaque),headsTotal:heads.length};
  heads.forEach((head,index)=>{
   const selected=new Set(head.objects),needed=new Set(head.objects);
   for(const o of head.objects)if(o.entryRef){const target=head.manifest.objects.find(x=>x.name===o.entryRef!.object);if(target)needed.add(target);}
   for(const o of needed){
    const token=head.manifestHash+'-o'+head.manifest.objects.indexOf(o),entry:Entry={object:o,token,head:index,apply:selected.has(o),previous:[0,0,0]};this.entries.push(entry);this.byToken.set(token,entry);
    if(entry.apply){this.state.apply.total++;this.state.apply.totalBytes+=o.originalBytes;}
    if(o.encoding!=='identity'&&!o.entryRef){this.state.decompress.total++;this.state.decompress.totalBytes+=o.originalBytes;}
    this.state.projection.total+=Math.ceil(o.originalBytes/262144);this.state.projection.totalBytes+=o.originalBytes;
    for(const [index,c] of (o.chunks??[]).entries()){let chunk=this.chunks.get(c.ciphertextSha256);if(!chunk){chunk={bytes:c.ciphertextBytes,done:false,users:[]};this.chunks.set(c.ciphertextSha256,chunk);this.state.download.total++;this.state.download.totalBytes+=c.ciphertextBytes;}else if(chunk.bytes!==c.ciphertextBytes)throw Error('cloud_snapshot_checkpoint_invalid');chunk.users.push({entry,index});}
   }
  });
  for(const e of this.entries)this.update(e);
  for(const hash of this.chunks.keys())this.updateChunk(hash);
  this.updateHeads();
 }
 private applied(e:Entry){return this.heads[e.head].alreadyApplied||this.receipts.has('applied:'+e.token);}
 private output(e:Entry){
  const o=e.object;if(this.applied(e)||this.receipts.has('decoded:'+e.token+'-object'))return o.originalBytes;
  // A legacy gzip object's source chunks are still compressed. Only its final
  // output receipt proves decompression. Independent gzip members can advance.
  if(o.encoding==='gzip'||o.entryRef)return 0;
  return Math.min(o.originalBytes,(o.chunks??[]).reduce((n,_c,i)=>n+(this.receipts.length(e.token+'-chunk-'+i)??0),0));
 }
 private update(e:Entry){
  const bytes=this.output(e),applied=e.apply&&this.applied(e)?1:0,decoded=bytes===e.object.originalBytes&&(bytes>0||this.receipts.has('decoded:'+e.token+'-object')||this.applied(e))?1:0;
  const [oldBytes,oldApplied,oldDecoded]=e.previous;
  this.state.projection.done+=Math.floor(bytes/262144)+(bytes===e.object.originalBytes&&bytes%262144>0?1:0)-Math.floor(oldBytes/262144)-(oldBytes===e.object.originalBytes&&oldBytes%262144>0?1:0);
  this.state.projection.doneBytes+=bytes-oldBytes;
  this.state.apply.done+=applied-oldApplied;this.state.apply.doneBytes+=(applied-oldApplied)*e.object.originalBytes;
  if(e.object.encoding!=='identity'&&!e.object.entryRef){this.state.decompress.done+=decoded-oldDecoded;this.state.decompress.doneBytes+=bytes-oldBytes;}
  e.previous=[bytes,applied,decoded];
 }
 private updateChunk(hash:string){const c=this.chunks.get(hash);if(!c)return;
  const done=this.receipts.has('download:'+hash)||c.users.some(({entry:e,index})=>this.applied(e)||this.receipts.has('decoded:'+e.token+'-object')||this.receipts.has('decoded:'+e.token+'-chunk-'+index)||this.receipts.has('decoded:'+e.token+'-chunk-'+index+'-input'));
  if(done!==c.done){this.state.download.done+=done?1:-1;this.state.download.doneBytes+=done?c.bytes:-c.bytes;c.done=done;}
 }
 private updateHeads(){this.state.headsDone=this.heads.filter(h=>this.acknowledged.includes(h.manifestHash)).length;}
 changed(unit:string){
  if(unit.startsWith('download:'))this.updateChunk(unit.slice(9));
  else {const match=/^(?:decoded:|applied:)([a-f0-9]{64}-o[0-9]+)(?:-|$)/.exec(unit),e=match&&this.byToken.get(match[1]);if(e){this.update(e);for(const c of e.object.chunks??[])this.updateChunk(c.ciphertextSha256);}}
 }
 acknowledge(hashes:readonly string[]){this.acknowledged=hashes;this.updateHeads();}
 snapshot():RestoreProgress{return JSON.parse(JSON.stringify(this.state));}
}
/** Closed release diagnostic: numbers only, no source identifiers or free text. */
export function restoreProgressDiagnostic(p:RestoreProgress){const out:Record<string,string|number>={event:'restore_progress',version:1,ready:Number(p.ready),full:Number(p.full),headsTotal:p.headsTotal,headsDone:p.headsDone};for(const key of ['download','decompress','apply','projection'] as const)for(const field of ['total','done','totalBytes','doneBytes'] as const)out[key+field[0].toUpperCase()+field.slice(1)]=p[key][field];return out;}
