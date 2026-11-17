import {capability,binding,snapshot,exact,array,hex,fail,envelope,type Envelope,type BeginPayload,type Capability,type Binding,type Snapshot,type Row} from './wire';
import {offerDigest,preparationDigest,capabilityDigest,requestDigest,selectionDigest,planDigest} from './digests';

/** Snapshot persistence belongs to the caller; do not reply until persist returns.
 * prepare has no job epoch. Confirm must finish writing before reverse begin.
 */
export class Preparation {
 private offer:{requestId:string;digest:string;phone:Capability}|null=null;
 private bindings:Binding[]=[];private frozen:{payload:Row;watchSnapshot:Snapshot}|null=null;
 private begun=new Map<string,{planDigest:string;pageObjectCounts:string}>();
 private confirmed=false;private confirmWritten=false;
 private watch:Capability;
 constructor(watch:Capability){this.watch=JSON.parse(JSON.stringify(capability(watch)));}
 async offerRequest(requestId:string,payload:Row,watchSnapshot:Snapshot,persist:(offer:Row)=>Promise<void>):Promise<Row> {
  if(this.offer||this.confirmed)fail('REQUEST_CONFLICT');hex(requestId,32);requestDigest(null,null,'prepare',payload);
  const p=exact(payload,['step','accountScope','phoneDeviceId','watchDeviceId','phoneCapabilities','phoneSnapshot','watchSnapshot']);
  if(p.step!=='offer')fail();capability(p.phoneCapabilities);snapshot(p.phoneSnapshot);if(p.watchSnapshot!==null)snapshot(p.watchSnapshot);snapshot(watchSnapshot);
  const phone=JSON.parse(JSON.stringify(p.phoneCapabilities)) as Capability;
  const digest=offerDigest(p,this.watch,watchSnapshot),result={step:'offer',watchCapabilities:JSON.parse(JSON.stringify(this.watch)),watchSnapshot:JSON.parse(JSON.stringify(watchSnapshot)),offerDigest:digest};
  await persist({requestId,payload:p,result});this.frozen=JSON.parse(JSON.stringify({payload:p,watchSnapshot}));this.offer={requestId,digest,phone};return result;
 }
 async confirmRequest(payload:Row,persist:(bindings:Binding[])=>Promise<void>):Promise<Row> {
  const p=exact(payload,['step','offerRequestId','bindings','preparationDigest']),offer=this.offer;
  if(!offer||this.confirmed||p.step!=='confirm'||p.offerRequestId!==offer.requestId)fail('REQUEST_CONFLICT');
  const bs=array(p.bindings,2).map(binding);if(!bs.length||bs.some((b,i)=>i>0&&bs[i-1]!.direction>=b.direction)||new Set(bs.map(b=>b.jobId)).size!==bs.length)fail('PLAN_CONFLICT');
  for(const b of bs){
   if(b.selection.limits.maxInFlightChunks!==1||b.selection.limits.maxInFlightBytes!==65536)fail('CAPABILITY_MISMATCH');
   for(const k of b.selection.kinds){
    const source=b.direction==='phoneToWatch'?offer.phone:this.watch,receiver=b.direction==='phoneToWatch'?this.watch:offer.phone;
    if(!source.kinds.some(x=>x.kind===k.kind&&x.send)||!receiver.kinds.some(x=>x.kind===k.kind&&x.receive))fail('CAPABILITY_MISMATCH');
   }
   for(const k of Object.keys(b.selection.limits) as (keyof Capability['limits'])[])if(b.selection.limits[k]!==Math.min(offer.phone.limits[k],this.watch.limits[k]))fail('CAPABILITY_MISMATCH');
  }
  if(p.preparationDigest!==preparationDigest(offer.digest,bs))fail('PLAN_CONFLICT');
  await persist(bs);this.bindings=JSON.parse(JSON.stringify(bs));this.confirmed=true;return {step:'confirm',preparationDigest:p.preparationDigest};
 }
 authorizeBegin(value:Envelope):BeginPayload {
  this.requireConfirmed();const r=envelope(value),f=this.frozen;
  if(!f||r.type!=='request'||r.phase!=='begin'||requestDigest(r.jobId,r.planDigest,'begin',r.payload!)!==r.requestDigest)fail('REQUEST_CONFLICT');
  const p=r.payload as unknown as BeginPayload,b=this.bindings.find(b=>b.jobId===r.jobId),prior=this.begun.get(r.jobId!);
  const sameSnapshot=(a:Snapshot,b:Snapshot)=>a.snapshotId===b.snapshotId&&a.manifestDigest===b.manifestDigest&&a.fromExclusive===b.fromExclusive&&a.toInclusive===b.toInclusive;
  if(!b||b.direction!==p.direction||selectionDigest(b.selection)!==p.selectionDigest||planDigest(p)!==r.planDigest||p.accountScope!==f.payload.accountScope||p.phoneDeviceId!==f.payload.phoneDeviceId||p.watchDeviceId!==f.payload.watchDeviceId||!sameSnapshot(p.phoneSnapshot,f.payload.phoneSnapshot as Snapshot)||!sameSnapshot(p.watchSnapshot,f.watchSnapshot))fail('PLAN_CONFLICT');
  if(!prior?b.intent!==p.intent:p.intent!==b.intent&&p.intent!=='resume')fail('PLAN_CONFLICT');
  // A lease regrant changes intent/epoch, never the first authorized plan or page partition.
  const pages=JSON.stringify(p.pageObjectCounts);
  if(prior&&(prior.planDigest!==r.planDigest||prior.pageObjectCounts!==pages))fail('PLAN_CONFLICT');
  if(!prior)this.begun.set(r.jobId!,{planDigest:r.planDigest!,pageObjectCounts:pages});
  return JSON.parse(JSON.stringify(p));
 }
 confirmResponseFullyWritten():void {if(!this.confirmed)fail('AUTH_REVOKED');this.confirmWritten=true;}
 requireConfirmed():void {if(!this.confirmWritten)fail('AUTH_REVOKED');}
 get watchCapabilityDigest():string{return capabilityDigest(this.watch);}
}
