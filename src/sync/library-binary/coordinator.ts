import {VerifiedChunkStore,type ObjectLease,type VerifiedObject,type VerifiedPublication} from '@podjs/framework/verified-chunk-store';
import {BinaryConnection} from './connection';
import {SwitchGate,checkSelectedLimits} from './routing';
import {Preparation} from './prepare';
import {Grant,ReceiveWindow,SendWindow,negativeReply,ControlSlots,RetryBackoff,TokenBucket,type JobBinding,type Pending} from './state';
import type {DataReader,ByteTransport,SourceFileChunk} from './codec';
import {ReceivePipeline,type ChunkWork} from './receive-pipeline';
import {ReceiveBindings,ReceiveIndex,bindingCapacity} from './receive-index';
import type {BinarySourcePlan} from './assets';
import {BookMetadataRejected} from './book-metadata';
import type {RecoveryRules} from './recovery';
import {frameBytes} from '../wire-frame-size';
import {BinaryStore,validateGraph,type Job,type ReceiptBoundary} from './store';
import {D,preparationDigest,selectionDigest,requestDigest,planDigest,descriptor,pageDigest,objectsRoot,receiptsRoot,completion} from './digests';
import {ACTION,VERSION,resumeError,ResumeError,fail,exact,row,capability,binding,hex,utf8,hash,type Row,type Capability,type Selection,type Snapshot,type ObjectDescriptor,type BeginPayload,type Binding,type Envelope,type AppliedReceipt,type Completion,BOOK_KINDS} from './wire';


export interface BinaryPorts {
 store:BinaryStore;chunks:VerifiedChunkStore;capability:Capability;
 accountScope:string;phoneDeviceId:string;watchDeviceId:string;connectionId:string;
 /** Holds the application's existing account-mutation lease through commit. */
 authorize<T>(run:()=>Promise<T>):Promise<T>;
 sleep(milliseconds:number):{result:Promise<void>;cancel():void};
 check():void;randomId():Promise<string>;
 freeze(peer:Capability):Promise<{witness:Snapshot;inventory:unknown}>;
 source(witness:Snapshot,selection:Selection):Promise<BinarySourcePlan>;
 apply(job:Job,object:ObjectDescriptor,path:string,boundary:ReceiptBoundary):Promise<void>;
 publish?(lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor,job:Job):Promise<VerifiedPublication>;
 cleanupCompleted?(job:Job):Promise<void>;
 stopLocalWork?():void;
 supportsRange?(p:BeginPayload):Promise<boolean>;
 applied?(kind:ObjectDescriptor['kind']):void;
 reserve(job:Job,objects:readonly ObjectDescriptor[]):Promise<void>;
 now():number;sampleClock?():Promise<void>;
 recovery?:RecoveryRules;
 diagnostic?(error:unknown):void;
}
const nativeObject=(o:ObjectDescriptor):VerifiedObject=>({id:o.objectId,size:o.size,sha256:o.sha256,chunkHashes:o.chunkHashes});
const sameSnapshot=(a:Snapshot,b:Snapshot)=>a.snapshotId===b.snapshotId&&a.manifestDigest===b.manifestDigest&&a.fromExclusive===b.fromExclusive&&a.toInclusive===b.toInclusive;
const terminal=(j:Job)=>j.state==='COMPLETE'||j.state==='CANCELLED';
type Offer={request:Envelope;payload:Row;watchSnapshot:Snapshot;digest:string;result:Row};
/** A single reader dispatches both requests and responses. Source pumps never
 * read the stream, and no v14 ACK is generated or consumed inside this owner.
 */
export class LibraryBinaryConnection {
 readonly scope:string;
 private readonly offers=new Map<string,Offer>();
 private bindings:Binding[]=[];
 private selectedOffer?:Offer;
 private readonly begun=new Set<string>();
 private retiredControls=new Map<string,Envelope>();
 private pending=new Map<string,{request:Envelope;resolve:(v:Envelope)=>void;reject:(e:unknown)=>void}>();
 private readonly binary:BinaryConnection;
 private readonly preparation:Preparation;
 private activeReceive=new Set<string>();
 private receive?:{job:Job;binding:JobBinding;window:ReceiveWindow;requests:ReceiveBindings;index?:ReceiveIndex;pipeline?:ReceivePipeline};
 private send?:{job:Job;window:SendWindow};
 private dataWake?:()=>void;
 private dataFailure?:unknown;
 private readonly retries:{pending:Pending;due:number}[]=[];
 private slots?:ControlSlots;
 private readonly stateBucket:TokenBucket;
 private readonly backoff=new RetryBackoff();
 private incoming:Promise<void>|undefined;
 private incomingBusy=false;
 private regrant?:{epoch:number;work:Promise<unknown>;unsettled:boolean};
 private readonly drainBuffer=new Uint8Array(4096);
 private nativeHeartbeat?:Promise<void>;
 private clockSync?:Promise<void>;
 private applying?:string;
 private stagingRequest?:Envelope;
 private incomingHeartbeatBusy=false;
 private dataReady=false;
 private sourceReading=false;
 private heartbeatTimer?:{cancel():void};
 private sourceHeartbeat?:Promise<Envelope>;
 private sourceEpoch?:{job:string;plan:string;epoch:number;last:number};
 private localWorkAt:number|null=null;
 private lastLocalUnit=0;
 private networkAt:number;
 private normalClose=false;private settled=new Set<string>();
 private sourceWork?:Promise<void>;
 private preparedSource?:BinarySourcePlan;
 private readonly sourcePlans=new Map<string,BeginPayload>();
 private readonly sourceDescriptions=new Map<string,readonly ObjectDescriptor[]>();
 private stopped=false;
 private closeReason:unknown;private cancelling?:Promise<void>;
 constructor(private readonly ports:BinaryPorts,gate:SwitchGate,private readonly io:ByteTransport){
  this.networkAt=ports.now();io.setNetworkProgress?.((kind,stream,epoch,sequence)=>{if(kind==='control'||kind==='data'&&stream===1&&epoch===this.receive?.job.epoch||kind==='ack'&&stream===2&&this.send?.window.acceptsAckProgress(epoch!,sequence!))this.networkAt=ports.now();});
  this.scope=D('wrss.library-binary.v2/storage',[ports.accountScope,ports.phoneDeviceId,ports.watchDeviceId]);
  this.binary=new BinaryConnection(gate,io,new Grant(ports.connectionId,1),ports.now,ports.capability.limits);
  this.preparation=new Preparation(ports.capability);this.stateBucket=new TokenBucket(8,4,ports.now());
 }
 private check(){this.ports.check();if(this.stopped||this.cancelling)throw this.closeReason??new ResumeError('USER_CANCELLED');}
 workUnit(){this.lastLocalUnit=this.ports.now();}
 private write(value:Envelope,started?:()=>void):Promise<void>{this.check();return this.binary.write({kind:'control',envelope:value},value.phase==='missing'&&value.payload?.limit===0?'urgent':'ordinary',started);}
 private reply(r:Envelope,result:Row|null,epoch:number|null,error?:ResumeError):Envelope{const {payload,...base}=r;return {...base,type:'response',success:!error,result,...(error?{error:error.wire()}:{}),epoch};}
 async close(error:unknown=new ResumeError('LOCAL_IO'),afterCancel=false){if(this.cancelling&&!afterCancel){await this.cancelling;return;}if(this.stopped)return;this.stopped=true;this.closeReason=error;this.ports.stopLocalWork?.();this.heartbeatTimer?.cancel();this.binary.close();this.receive?.window.grant.fence();void this.receive?.pipeline?.fence();this.send?.window.close();this.slots?.clear();for(const p of this.pending.values())p.reject(error);this.pending.clear();this.failData(error);await this.ports.store.revokeConnection(this.ports.connectionId);}
 cancel():Promise<void>{
  if(this.cancelling)return this.cancelling;if(this.stopped)return Promise.resolve();const error=new ResumeError('USER_CANCELLED');this.closeReason=error;this.ports.stopLocalWork?.();
  this.receive?.window.grant.fence();const draining=this.receive?.pipeline?.fence();this.send?.window.close();
  for(const j of [this.receive?.job,this.send?.job])if(j)try{void this.binary.write({kind:'control',envelope:this.makeRequest('cancel',j.jobId,j.planDigest,j.epoch,{reason:'USER_CANCEL'})},'urgent').catch(()=>{});}catch{/* The transport may already be closed; tombstones remain mandatory. */}this.binary.close();
  for(const p of this.pending.values())p.reject(error);this.pending.clear();this.failData(error);
  return this.cancelling=Promise.resolve(draining).then(()=>this.ports.store.exclusive(async()=>{for(const b of this.bindings){const j=await this.ports.store.job(this.scope,b.jobId);if(j?.state!=='COMPLETE')await this.ports.store.db.execute('INSERT OR REPLACE INTO library_binary_cancellations VALUES(?,?,?,?)',[this.scope,b.jobId,'USER_CANCEL',this.ports.store.now()+86400000]);if(j)await this.ports.store.cancel(j);}await this.cleanupCancelledReceiver();})).finally(()=>this.close(error,true));
 }
 private async cleanupCancelledReceiver(){const receive=this.receive;if(!receive?.job.lease)return;const j=receive.job;try{await this.ports.chunks.revokeWrites(j.lease as unknown as ObjectLease);let released=await this.cleanupApplied(j);for(const id of this.activeReceive){const o=await this.ports.store.object(j,id);try{await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),false);}catch{released=false;}}if(released&&!j.description.selection.kinds.some(k=>k.kind.startsWith('book')))await this.ports.store.db.transaction([this.ports.store.guard(j,true),{sql:'DELETE FROM library_binary_peaks WHERE scope=? AND job_id=?',params:[j.scope,j.jobId]}]);}catch{/* Keep the reservation until delayed native collection succeeds. */}}
 async run():Promise<void>{
  try{await this.ports.store.exclusive(()=>this.ports.store.openConnection(this.ports.connectionId));this.tick();
   while(!this.stopped){const frame=await this.binary.read(this.readData);this.check();if(!frame)continue;
    if(frame.kind==='ack'){
     if(!this.send)fail();
     const settled=this.send.window.acceptAck(frame,this.ports.now());
     if(settled){
      for(const {pending,disposition} of settled){
       const d=this.sourceDescriptions.get(this.send.job.jobId)?.[pending.objectSlot];if(!d)fail('OBJECT_CONFLICT');
       if(disposition===1)this.ports.recovery?.confirm('STAGED','watchToPhone:'+d.objectId+':'+pending.chunkIndex);
      }
      this.backoff.reset();this.wakeData();
     }
     continue;
    }
    if(frame.kind==='data'){
     const {payload,...header}=frame;let at=0;
     await this.readData({...header,payloadBytes:payload.length},async target=>{
      target.set(payload.subarray(at,at+target.length));at+=target.length;
     });
     continue;
    }
    const r=frame.envelope;
    if(r.type==='response'){
     if(r.phase==='putChunk'){
      if(!this.send)fail();
      const n=this.send.window.negative(r,this.ports.now());
      if(n){
       const error=new ResumeError(String(r.error!.code));
       if(n.action==='WAIT'&&!this.dataFailure){
        this.stateBucket.take(this.ports.now());
        this.retries.push({pending:n.pending,due:this.ports.now()+this.backoff.next(n.retryAfterMillis)});
       }else if(n.action!=='WAIT'){
        this.failData(error);
        if(n.action==='REPLAN'||n.action==='STOP')throw error;
       }
       this.wakeData();
      }
      continue;
     }
     const p=this.pending.get(r.requestId),send=this.send,retired=this.retiredControls.get(r.requestId);
     if(send&&r.epoch!==null&&r.jobId===send.job.jobId&&r.planDigest===send.job.planDigest){
      if(r.phase!=='begin'&&send.window.oldEpoch(r.epoch)){
       this.binary.staleAckBudget.take(this.ports.now());continue;
      }
      if(!p&&retired&&r.requestDigest===retired.requestDigest&&r.epoch===retired.epoch){
       this.binary.staleAckBudget.take(this.ports.now());continue;
      }
     }
     if(!p)fail('REQUEST_CONFLICT');
     this.slots!.settle(r);
     if(r.success){
      this.validateAnswer(r,p.request);
      if(r.phase==='begin'&&send){
       const epoch=r.epoch!;
       if(epoch>send.window.currentEpoch)send.window.regrant(epoch);
       else if(epoch!==send.window.currentEpoch||send.window.credit.chunks)fail('STALE_EPOCH');
      }
     }
     this.pending.delete(r.requestId);p.resolve(r);
     if(r.success&&(r.phase==='complete'||r.phase==='begin'&&r.result!.state==='COMPLETE'))await this.sourceWork;
     continue;
    }
    if(r.phase==='missing'&&r.payload!.limit===0){
     if(this.incomingHeartbeatBusy)fail('FLOW_CONTROL_VIOLATION');this.incomingHeartbeatBusy=true;
     void this.answerHeartbeat(r).catch(e=>this.close(e)).finally(()=>{this.incomingHeartbeatBusy=false;});continue;
    }
    if(r.phase==='cancel'&&r.payload!.reason==='USER_CANCEL'){
     const j=this.receive?.job;
     if(j?.jobId===r.jobId&&j.planDigest===r.planDigest&&j.epoch===r.epoch){
      try{this.checkReceiveBinding(r);}catch(e){const error=resumeError(e);await this.write(this.reply(r,null,r.epoch,error));throw error;}
     }
     void this.cancel().catch(()=>{});continue;
    }
    if(this.incomingBusy)fail('FLOW_CONTROL_VIOLATION');
    if(r.phase==='cancel'||r.phase==='begin'&&this.receive?.job.jobId===r.jobId)this.fenceReceiver();
    this.incomingBusy=true;
    this.incoming=this.answer(r).finally(()=>{this.incomingBusy=false;});void this.incoming.catch(e=>this.close(e));
   }
   if(!this.normalClose)throw this.closeReason;
  }catch(e){if(!this.normalClose)throw this.closeReason??e;}finally{await this.close();await this.incoming?.catch(()=>{});await this.sourceWork?.catch(()=>{});}
 }
 private tick(){const timer=this.ports.sleep(1000);this.heartbeatTimer=timer;void timer.result.then(async()=>{if(this.stopped)return;await this.ports.sampleClock?.();if(this.stopped)return;const at=this.ports.now();
  if(!this.clockSync)this.clockSync=this.ports.store.observeClock(Math.floor(at)).catch(e=>this.close(e)).finally(()=>{this.clockSync=undefined;});
  const remoteWork=!!this.send?.window.credit.chunks||[...this.pending.values()].some(p=>['manifestPage','apply','complete','missing'].includes(p.request.phase));const localWork=this.localWorkAt!==null||this.receive?.pipeline?.working||this.sourceReading;if(!remoteWork&&!localWork&&at-this.networkAt>=30000){await this.close(Error('SocketTimeout'));return;}if(localWork&&at-this.lastLocalUnit>=30000){await this.close(new ResumeError('LOCAL_IO'));return;}
  const source=this.sourceEpoch;if(source&&at-source.last>=8000&&!this.sourceHeartbeat){source.last=at;this.sourceHeartbeat=this.request('missing',source.job,source.plan,source.epoch,{afterObjectId:null,afterChunkIndex:null,limit:0},false);void this.sourceHeartbeat.catch(e=>{if(e instanceof ResumeError&&e.code==='LEASE_EXPIRED'){this.failData(e);for(const [id,p] of this.pending){this.retiredControls.set(id,p.request);if(this.retiredControls.size>2)this.retiredControls.delete(this.retiredControls.keys().next().value!);p.reject(e);}this.pending.clear();this.slots?.clear();}else return this.close(e);}).finally(()=>{this.sourceHeartbeat=undefined;});}this.tick();},e=>{if(!this.stopped)void this.close(e);}).catch(e=>this.close(e));}
 private async answerHeartbeat(r:Envelope){
  try{
   this.check();
   const j=this.receive?.job;
   if(!j||j.jobId!==r.jobId||!this.begun.has(j.jobId)||j.connectionId!==this.ports.connectionId||j.epoch!==r.epoch||j.planDigest!==r.planDigest)fail('AUTH_REVOKED');
   this.checkReceiveBinding(r);
   await this.write(this.reply(r,{state:j.state,nextManifestPage:j.nextPage,expiresAtMillis:j.expiresAt,completion:j.completion,items:[],next:null,done:true},j.epoch));
   if(j.lease&&!this.regrant&&!this.nativeHeartbeat&&!this.stopped){
    this.nativeHeartbeat=this.ports.chunks.check(j.lease as unknown as ObjectLease).catch(e=>{
     const error=resumeError(e);
     if(!this.stopped&&!this.regrant&&!['BUSY','LEASE_EXPIRED','STALE_EPOCH'].includes(error.code))void this.close(error);
    }).finally(()=>{this.nativeHeartbeat=undefined;});
   }
  }catch(e){const error=resumeError(e);await this.write(this.reply(r,null,r.epoch,error));if(error.wire().recovery==='STOP')throw error;}
 }
 private async answer(r:Envelope){let after:(()=>void)|undefined,charged=false;const charge=()=>{if(!charged){this.stateBucket.take(this.ports.now());charged=true;}};
  try{this.localWorkAt=this.ports.now();this.workUnit();
   if(r.phase==='begin'||r.phase==='cancel')await this.regrant?.work;
   const result=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.handle(r,charge)));this.check();await this.write(this.reply(r,result.result,result.epoch),()=>{
    if(r.phase==='begin'){this.regrant=undefined;this.dataReady=!!this.receive?.pipeline;}
    if(r.phase==='manifestPage'&&result.result.manifestVerified)this.dataReady=true;
   });after=result.after;
   if(r.phase==='prepare'&&r.payload!.step==='confirm')this.preparation.confirmResponseFullyWritten();
  }catch(e){let error=resumeError(e);if(error.wire().class==='STATE')try{charge();}catch(limit){error=resumeError(limit);}if(!this.stopped)await this.write(this.reply(r,null,r.epoch,error));if(error.wire().recovery==='STOP')throw error;}
  finally{this.localWorkAt=null;}
  after?.();if(['complete','cancel'].includes(r.phase)||r.phase==='begin'&&terminal((await this.ports.store.job(this.scope,r.jobId!))!)){this.settled.add(r.jobId!);await this.finishIfTerminal();}
 }
 private async finishIfTerminal(){if(this.bindings.length&&this.bindings.every(b=>this.settled.has(b.jobId))&&await this.allTerminal()){this.normalClose=true;await this.close();}}
 private binding(j:Job):JobBinding{return {streamId:j.description.direction==='phoneToWatch'?1:2,jobId:j.jobId,planDigest:j.planDigest,selectionDigest:j.description.selectionDigest};}
 private fenceReceiver(){
  const receive=this.receive;
  if(!receive||this.regrant)return;
  const epoch=receive.job.epoch,pipeline=receive.pipeline;
  this.dataReady=false;
  this.regrant={epoch,unsettled:pipeline?.busy??false,work:pipeline?.fence()??Promise.resolve()};
  this.binary.discardReceiveEpoch(epoch);
 }
 private readonly readData:DataReader=async(header,read,readFile)=>{
  const receive=this.receive;
  if(!receive||header.streamId!==1)fail('AUTH_REVOKED');
  if(this.regrant){
   if(!receive.window.granted(header.epoch)||header.epoch>this.regrant.epoch)fail('STALE_EPOCH');
   this.binary.staleAckBudget.take(this.ports.now());
   if(readFile&&receive.job.description.selection.kinds.some(k=>k.kind.startsWith('book'))){await readFile(false);return;}
   for(let left=header.payloadBytes;left>0;){
    const size=Math.min(left,this.drainBuffer.length);await read(this.drainBuffer.subarray(0,size));left-=size;
   }
   return;
  }
  if(!this.dataReady||!receive.pipeline)fail('FLOW_CONTROL_VIOLATION');
  await receive.pipeline.read(header,read,readFile);
 };
 private chunkRequest(j:Job,{header,object}:ChunkWork):Envelope{
  return {action:ACTION,version:VERSION,phase:'putChunk',type:'request',jobId:j.jobId,planDigest:j.planDigest,epoch:header.epoch,
   requestId:header.requestId,requestDigest:header.requestDigest,payload:{objectId:object.objectId,chunkIndex:header.chunkIndex}};
 }
 private enableData(){
  const receive=this.receive!,j=receive.job,index=receive.index!,requests=receive.requests;
  if(receive.pipeline&&!this.regrant)return;
  receive.window.admit();
  const peer=this.ports.phoneDeviceId;
  const reserved=new Map<string,number>();
  const releaseSlot=(id:string)=>{
   const left=reserved.get(id);
   if(left===1)reserved.delete(id);
   else if(left)reserved.set(id,left-1);
  };
  const writeReply=(frame:Parameters<BinaryConnection['write']>[0],started:()=>void,error?:ResumeError)=>{
   void this.binary.write(frame,'urgent',started,j.epoch).then(()=>{
    if(error&&error.wire().recovery==='STOP')return this.close(error);
   },e=>{if(this.regrant?.epoch!==j.epoch&&!this.stopped)return this.close(e);}).catch(e=>this.close(e));
  };
  receive.pipeline=new ReceivePipeline(receive.window,j.description.selection.limits,{
   live:()=>this.check(),now:()=>performance.now(),sleep:ms=>this.ports.sleep(ms),
   applied:id=>index.isApplied(id),dropFile:file=>this.io.dropFile?.(file)??Promise.resolve(),
   stale:()=>this.binary.staleAckBudget.take(this.ports.now()),stop:e=>{void this.close(e);},
   admission:d=>{
    this.workUnit();
    const id=d.objectId,queued=reserved.get(id)??0;
    if(this.applying===id)return new ResumeError('BUSY');
    if(index.isApplied(id))return;
    if(!queued&&!this.activeReceive.has(id)){
     const unstarted=Array.from(reserved.keys()).filter(objectId=>!this.activeReceive.has(objectId)).length;
     if(this.activeReceive.size+unstarted>=this.receiverSlots(j))return new ResumeError('WINDOW_FULL');
    }
    reserved.set(id,queued+1);
   },
   // Staging is limited to the native account/connection/epoch lease.
   // The separately queued SQLite commit holds the account mutation lease.
   stage:async chunk=>{
    const {object:d,header:f}=chunk,r=this.chunkRequest(j,chunk);
    const lease=j.lease as unknown as ObjectLease;
    let claimed=false;
    try{
     chunk.check();
     if(requests.hasBinding(r))this.stateBucket.take(this.ports.now());
     this.stagingRequest=r;
     if(index.isApplied(d.objectId)){
      await this.ports.chunks.check(lease);chunk.check();requests.remember(r);return 2;
     }
     if(d.dependsOn.some(id=>!index.isApplied(id)))fail('DEPENDENCIES_PENDING');
     claimed=!this.activeReceive.has(d.objectId);
     this.admit(j,d);
     const request={id:f.requestId,digest:f.requestDigest};
     if('file' in chunk)await this.ports.chunks.stageFileReceipt(lease,nativeObject(d),f.chunkIndex,chunk.file,request);
     else await this.ports.chunks.stageReceipt(lease,nativeObject(d),f.chunkIndex,chunk.payload,request);
     claimed=false; // A late fence must still retire the staged native object.
     chunk.check();requests.remember(r);this.workUnit();return 1;
    }catch(e){
     if(claimed)this.activeReceive.delete(d.objectId);
     throw e;
    }finally{this.stagingRequest=undefined;releaseSlot(d.objectId);}
   },
   commit:(group,check)=>this.ports.authorize(()=>this.ports.store.exclusive(async()=>{
    check();
    await this.ports.store.commitChunks(j,peer,group.map(chunk=>this.chunkRequest(j,chunk)));
    check();this.workUnit();
    for(const {object,header,disposition} of group)if(disposition===1)this.ports.recovery?.confirm('STAGED','phoneToWatch:'+object.objectId+':'+header.chunkIndex);
   })),
   ack:(ack,started)=>writeReply(ack,started),
   negative:(header,error,started)=>{
    if(error.wire().class==='STATE')this.stateBucket.take(this.ports.now());
    writeReply({kind:'control',envelope:negativeReply(receive.binding,header,error)},started,error);
   },
  });
 }
 private async allTerminal(){for(const b of this.bindings){const j=await this.ports.store.job(this.scope,b.jobId);if(!j||!terminal(j))return false;}return true;}
 private checkReceiveBinding(r:Envelope){
  if(this.stagingRequest?.requestId===r.requestId&&this.stagingRequest.requestDigest!==r.requestDigest)fail('REQUEST_CONFLICT');
  this.receive?.requests.hasBinding(r);
 }
 private async handle(r:Envelope,charge:()=>void):Promise<{result:Row;epoch:number|null;after?:()=>void}>{
  const p=r.payload!;
  if(r.phase==='prepare')return this.prepare(r);
  const b=this.bindings.find(v=>v.jobId===r.jobId);if(!b||!this.selectedOffer)fail('CAPABILITY_MISMATCH');
  if(r.phase==='begin')return this.begin(r,p as unknown as BeginPayload,b);
  const j=await this.ports.store.job(this.scope,r.jobId!);if(!j)fail('NOT_FOUND');
  if(j.planDigest!==r.planDigest)fail('JOB_CONFLICT');if(frameBytes(r)+12>j.description.selection.limits.maxFrameBytes)fail('LIMIT_EXCEEDED');
  if(j.connectionId!==this.ports.connectionId||j.epoch!==r.epoch)fail('STALE_EPOCH');
  if(j.expiresAt<this.ports.store.now())fail('EXPIRED');
  if(j.role!=='receiver'&&r.phase!=='cancel')fail();
  const receive=this.receive?.job.jobId===j.jobId?this.receive:undefined;
  if(receive){this.checkReceiveBinding(r);receive.requests.remember(r);}
  const replay=await this.ports.store.checkBinding(j,this.ports.phoneDeviceId,r,undefined,charge);
  if(j.state==='CANCELLED'&&!['missing','cancel'].includes(r.phase))fail('JOB_CANCELLED');
  if(j.lease)await this.ports.chunks.check(j.lease as unknown as ObjectLease);
  let result:Row;
  switch(r.phase){
   case 'manifestPage':{
    if(terminal(j))fail('PLAN_CONFLICT');
    let index:ReceiveIndex|undefined;
    result=await this.ports.store.manifest(j,r,this.ports.phoneDeviceId,p,async objects=>{
     await this.ports.reserve(j,objects);
     index=this.buildReceiveIndex(j,objects,[]);
    });
    if(index)receive!.index=index;
    break;
   }
   case 'missing':result=await this.missing(j,p);await this.ports.store.db.transaction(this.ports.store.bind(j,this.ports.phoneDeviceId,r));break;
   case 'apply':{
    if(replay?.errorCode==='BUSINESS_REJECTED')fail('BUSINESS_REJECTED');
    const id=String(p.objectId);
    if(receive?.index&&receive.pipeline?.busyOn(receive.index.slot(id)))fail('BUSY');
    this.applying=id;
    try{result=await this.apply(j,r);}catch(error){
     if(error instanceof BookMetadataRejected){
      this.check();
      await this.ports.store.rejectBookMetadata(j,this.ports.phoneDeviceId,r);
     }
     throw error;
    }finally{this.applying=undefined;}
    break;
   }
   case 'complete':result=await this.ports.store.complete(j,r,this.ports.phoneDeviceId,p) as unknown as Row;if(await this.cleanupApplied(j)){
    let clean=true;
    try{await this.ports.cleanupCompleted?.(j);}catch(e){clean=false;this.ports.diagnostic?.(e);}
    if(clean)await this.ports.store.db.transaction([this.ports.store.guard(j),{sql:'DELETE FROM library_binary_peaks WHERE scope=? AND job_id=?',params:[j.scope,j.jobId]}]);}this.ports.recovery?.confirm('COMPLETE','phoneToWatch:'+j.description.objectsRoot);break;
   case 'cancel':result=await this.ports.store.cancel(j,r,this.ports.phoneDeviceId);if(j.lease&&j.state!=='COMPLETE'){await this.ports.chunks.revokeWrites(j.lease as unknown as ObjectLease);for(const id of this.activeReceive){const o=await this.ports.store.object(j,id);await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),false);this.workUnit();}this.activeReceive.clear();}break;
   default:fail();
  }
  await this.ports.store.touch(j);
  if(j.role==='receiver'&&this.receive?.job.jobId===j.jobId){
   this.receive.job=(await this.ports.store.job(this.scope,j.jobId))!;
   if(r.phase==='manifestPage'&&result.manifestVerified)this.enableData();
  }
  return {result,epoch:j.epoch,...(r.phase==='cancel'?{after:()=>{void this.close(new ResumeError(p.reason==='SOURCE_CHANGED'?'SOURCE_CHANGED':'JOB_CANCELLED'));}}:{})};
 }
 private async prepare(r:Envelope):Promise<{result:Row;epoch:null;after?:()=>void}>{
  const p=r.payload!;await this.ports.store.bindPreparation(this.scope,this.ports.connectionId,r.requestId,r.requestDigest);
  if(p.step==='offer'){
   const cached=this.offers.get(r.requestId);if(cached)return {result:cached.result,epoch:null};
   if(this.offers.size>=4)fail('LIMIT_EXCEEDED');
   if(p.accountScope!==this.ports.accountScope)fail('ACCOUNT_MISMATCH');if(p.phoneDeviceId!==this.ports.phoneDeviceId||p.watchDeviceId!==this.ports.watchDeviceId)fail('PEER_MISMATCH');const phone=capability(p.phoneCapabilities);await this.ports.store.budget(0,Math.min(phone.limits.maxJournalBytes,this.ports.capability.limits.maxJournalBytes));
   let witness:Snapshot;
   if(p.watchSnapshot===null){const frozen=await this.ports.freeze(phone);witness=frozen.witness;await this.ports.store.saveSnapshot(this.scope,witness,frozen.inventory);}
   else{witness=p.watchSnapshot as unknown as Snapshot;const old=await this.ports.store.snapshot(this.scope,witness.snapshotId);if(!old)fail('SOURCE_CHANGED');if(!sameSnapshot(old.witness,witness))fail('PLAN_CONFLICT');}
   const result=await this.preparation.offerRequest(r.requestId,p,witness,async()=>{}),digest=String(result.offerDigest);
   this.offers.set(r.requestId,{request:r,payload:p,watchSnapshot:witness,digest,result});return {result:result as unknown as Row,epoch:null};
  }
  const offer=this.offers.get(String(p.offerRequestId));if(!offer)fail('CAPABILITY_MISMATCH');
  if(!Array.isArray(p.bindings))fail();const bs=(p.bindings as unknown[]).map(binding);if(bs.length<1||bs.length>2||new Set(bs.map(b=>b.jobId)).size!==bs.length||bs.some((b,i)=>i>0&&bs[i-1]!.direction>=b.direction))fail('CAPABILITY_MISMATCH');
  for(const b of bs){this.checkSelection(b,offer.payload.phoneCapabilities as unknown as Capability);const old=await this.ports.store.job(this.scope,b.jobId);if(old?.state!=='COMPLETE'&&(await this.ports.store.db.query('SELECT job_id FROM library_binary_cancellations WHERE scope=? AND job_id=?',[this.scope,b.jobId])).length)fail('JOB_CANCELLED');if(old&&(old.description.direction!==b.direction||old.description.selectionDigest!==selectionDigest(b.selection)||!sameSnapshot(old.description.phoneSnapshot,offer.payload.phoneSnapshot as unknown as Snapshot)||!sameSnapshot(old.description.watchSnapshot,offer.watchSnapshot)))fail('JOB_CONFLICT');if(b.direction==='watchToPhone'&&b.intent==='resume'&&!old)fail('NOT_FOUND');}
  await this.ports.store.budget(0,Math.min(...bs.map(b=>b.selection.limits.maxJournalBytes)));const digest=preparationDigest(offer.digest,bs);if(digest!==p.preparationDigest)fail('PLAN_CONFLICT');
  if(this.bindings.length&&preparationDigest(this.selectedOffer!.digest,this.bindings)!==digest)fail('PLAN_CONFLICT');
  if(this.bindings.length){this.stateBucket.take(this.ports.now());return {result:{step:'confirm',preparationDigest:digest},epoch:null};}
  const reverse=bs.find(b=>b.direction==='watchToPhone');if(reverse?.intent==='create'){this.preparedSource=await this.ports.source(offer.watchSnapshot,reverse.selection);validateGraph(this.preparedSource.objects);for(const d of this.preparedSource.objects)descriptor(d,reverse.selection.limits);}
  await this.ports.store.preparation(this.scope,digest,{phoneSnapshot:offer.payload.phoneSnapshot,watchSnapshot:offer.watchSnapshot,bindings:bs,...(this.preparedSource?{sourceObjects:this.preparedSource.objects}:{})});
  await this.preparation.confirmRequest(p,async()=>{});this.bindings=bs;this.selectedOffer=offer;
  return {result:{step:'confirm',preparationDigest:digest},epoch:null,after:()=>{
   if(this.sourceWork||!bs.some(b=>b.direction==='watchToPhone'))return;
   this.sourceWork=this.sendSource(bs.find(b=>b.direction==='watchToPhone')!).catch(e=>{void this.close(e);throw e;});void this.sourceWork.catch(()=>{});
  }};
 }
 private checkSelection(b:Binding,phone:Capability){
  const watch=this.ports.capability;
  for(const k of b.selection.kinds){const w=watch.kinds.find(v=>v.kind===k.kind&&v.schemaVersion===k.schemaVersion),p=phone.kinds.find(v=>v.kind===k.kind&&v.schemaVersion===k.schemaVersion);if(!w||!p||!(b.direction==='phoneToWatch'?w.receive&&p.send:w.send&&p.receive))fail('CAPABILITY_MISMATCH');}
  if(b.selection.kinds.some(k=>k.kind.startsWith('book'))&&
    !BOOK_KINDS.every(kind=>b.selection.kinds.some(k=>k.kind===kind)&&[phone,watch].every(c=>c.kinds.some(k=>k.kind===kind&&k.send&&k.receive))))fail('CAPABILITY_MISMATCH');
  checkSelectedLimits(b,phone,watch);
 }
 private async begin(r:Envelope,p:BeginPayload,b:Binding){
  this.preparation.authorizeBegin(r);
  if(b.direction!=='phoneToWatch'||p.direction!==b.direction||p.accountScope!==this.ports.accountScope||p.phoneDeviceId!==this.ports.phoneDeviceId||p.watchDeviceId!==this.ports.watchDeviceId)fail('PEER_MISMATCH');
  if(frameBytes(r)+12>b.selection.limits.maxFrameBytes)fail('LIMIT_EXCEEDED');const offer=this.selectedOffer!;if(!sameSnapshot(p.phoneSnapshot,offer.payload.phoneSnapshot as unknown as Snapshot)||!sameSnapshot(p.watchSnapshot,offer.watchSnapshot)||p.selectionDigest!==selectionDigest(b.selection)||planDigest(p)!==r.planDigest)fail('PLAN_CONFLICT');
  if(!this.begun.has(b.jobId)&&p.intent!==b.intent)fail('JOB_CONFLICT');
  const old=await this.ports.store.job(this.scope,b.jobId);if(p.intent==='resume'&&!old)fail('NOT_FOUND');if(old&&old.planDigest!==r.planDigest)fail('JOB_CONFLICT');
  if(old&&old.expiresAt<this.ports.store.now())fail('EXPIRED');
  if(terminal(old??({state:'READY'} as Job))&&p.intent==='create')fail('JOB_CONFLICT');
  const source=p.phoneSnapshot;if(source.toInclusive!==0&&!await this.ports.supportsRange?.(p))fail('BUSINESS_REJECTED');
  await this.ports.store.preflightBegin(this.scope,b.jobId,p);const lease=await this.ports.chunks.acquire(D('wrss.library-binary.v2/native-scope',[this.scope,b.jobId]),this.ports.connectionId,!!old&&terminal(old),{...b.selection.limits,maxInFlightObjects:this.receiverSlotsFor(b.selection),maxStagingBytes:Math.min(134217728,b.selection.limits.maxStagingBytes)});
  if(this.regrant?.unsettled&&lease.epoch<=this.regrant.epoch)fail('STALE_EPOCH');
  const requests=await this.restoreReceiveBindings(lease,old,b.selection);
  requests.remember(r);
  const job=await this.ports.store.begin(this.scope,r,p,this.ports.connectionId,lease.epoch,lease as unknown as Row);this.begun.add(b.jobId);
  await this.ports.store.db.transaction(this.ports.store.bind(job,this.ports.phoneDeviceId,r));
  const rows=await this.verifyRestored(job);await this.cleanupApplied(job);
  const objects=rows.map(o=>o.descriptor);
  if(!terminal(job)&&job.state!=='PLANNING')await this.ports.reserve(job,objects);
  const binding=this.binding(job);
  if(this.receive){
   if(job.epoch>this.receive.job.epoch)this.receive.window.regrant(job.epoch);
   this.receive.job=job;this.receive.requests=requests;this.receive.pipeline=undefined;this.receive.index=undefined;
  }else{
   this.receive={job,binding,requests,window:new ReceiveWindow(binding,new Grant(this.ports.connectionId,job.epoch),{
    objectCount:p.objectCount,at:async slot=>this.receive?.index?.at(slot)??null,
   })};
  }
  if(!terminal(job)&&job.state!=='PLANNING'){
   this.activeReceive.clear();
   for(const o of rows)if(!o.receipt){
    const status=await this.ports.chunks.status(job.lease as unknown as ObjectLease,nativeObject(o.descriptor));
    if(status.state!=='PENDING')this.activeReceive.add(o.descriptor.objectId);this.workUnit();
   }
   this.receive.index=this.buildReceiveIndex(job,objects,rows.filter(o=>o.receipt).map(o=>o.descriptor.objectId));
   this.enableData();
  }
  return {result:{disposition:old?'RESUMED':'CREATED',selectionDigest:p.selectionDigest,state:job.state,expiresAtMillis:job.expiresAt,nextManifestPage:job.nextPage,completion:job.completion},epoch:job.epoch};
 }
 private async restoreReceiveBindings(lease:ObjectLease,prior:Job|null,selection:Selection):Promise<ReceiveBindings>{
  // The new native grant fences older writers. A committed file-stage binding
  // can survive a failed business transaction and still owns its request ID.
  const requests=new ReceiveBindings(bindingCapacity(selection));
  if(prior)for await(const entry of this.ports.store.receiveBindings(prior,this.ports.phoneDeviceId)){requests.remember(entry);this.workUnit();}
  let after:string|undefined;
  do{
   const page=await this.ports.chunks.requestBindings(lease,after);
   for(const entry of page.entries)requests.remember({requestId:entry.id,requestDigest:entry.digest});
   after=page.next;this.workUnit();
  }while(after!==undefined);
  return requests;
 }
 private buildReceiveIndex(j:Job,objects:readonly ObjectDescriptor[],applied:readonly string[]){
  const {selection,objectCount}=j.description;
  if(objects.length!==objectCount||objects.length>Math.min(512,selection.limits.maxPlanObjects))fail('LIMIT_EXCEEDED');
  const bytes=objects.reduce((size,object)=>size+utf8(JSON.stringify(object)).length,0);
  if(bytes>Math.min(selection.kinds.some(k=>k.kind.startsWith('book'))?786432:262144,selection.limits.maxManifestBytes))fail('LIMIT_EXCEEDED');
  return new ReceiveIndex(objects,applied);
 }
 private async verifyRestored(j:Job){
  if(j.role!=='receiver'||j.state==='CANCELLED')return [];
  const all=await this.ports.store.objects(j),p=j.description,expected=p.pageObjectCounts.slice(0,j.nextPage).reduce((n,x)=>n+x,0);
  if(all.length!==expected||all.some((o,i)=>o.ordinal!==i||i>0&&all[i-1]!.descriptor.objectId>=o.descriptor.objectId))fail('JOURNAL_CORRUPT');
  const pages=await this.ports.store.db.query('SELECT page_index,digest FROM library_binary_pages WHERE scope=? AND job_id=? ORDER BY page_index',[j.scope,j.jobId]);if(pages.length!==j.nextPage)fail('JOURNAL_CORRUPT');
  let at=0,previous='0'.repeat(64),total=0;for(let index=0;index<j.nextPage;index++){const entries=all.slice(at,at+p.pageObjectCounts[index]!).map(o=>o.descriptor),digest=pageDigest(j.planDigest,index,at,entries,previous);if(Number(pages[index]!.page_index)!==index||pages[index]!.digest!==digest)fail('JOURNAL_CORRUPT');total+=utf8(JSON.stringify(entries)).length;previous=digest;at+=entries.length;this.workUnit();}
  if(total>p.selection.limits.maxManifestBytes)fail('JOURNAL_CORRUPT');
  if(j.state!=='PLANNING'){if(all.length!==p.objectCount||objectsRoot(all.map(o=>o.descriptor.objectId))!==p.objectsRoot)fail('JOURNAL_CORRUPT');validateGraph(all.map(o=>o.descriptor));}
  if(j.state==='COMPLETE'){if(all.some(o=>!o.receipt)||!j.completion)fail('RECEIPT_CONFLICT');const root=receiptsRoot(all.map(o=>o.receipt!)),expected=completion(j.jobId,j.planDigest,p.objectCount,root,p.phoneSnapshot.toInclusive);if(Object.keys(expected).some(k=>j.completion![k as keyof Completion]!==expected[k as keyof Completion]))fail('RECEIPT_CONFLICT');}
  return all;
 }
 private async cleanupApplied(j:Job,d?:ObjectDescriptor):Promise<boolean>{
  if(!j.lease)return true;let released=true;
  for(const o of d?[await this.ports.store.object(j,d.objectId)]:await this.ports.store.objects(j)){
   if(!o.receipt)continue;
   try{await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),!['noteAsset','readerResource','bookPackageSegment'].includes(o.descriptor.kind));}catch(e){released=false;this.ports.diagnostic?.(e);}
  }return released;
 }
 private async missing(j:Job,p:Row):Promise<Row>{
  await this.cleanupApplied(j);const items:Row[]=[],limit=Number(p.limit),base={state:j.state,nextManifestPage:j.nextPage,expiresAtMillis:j.expiresAt,completion:j.completion};
  if(limit===0||j.state==='CANCELLED')return {...base,items,next:null,done:true};
  if(j.state==='PLANNING')fail('MANIFEST_INCOMPLETE');if(limit>j.description.selection.limits.maxResultsPerPage)fail();
  const all=await this.ports.store.objects(j);let start=0,chunk=0;
  if(p.afterObjectId!==null){const index=all.findIndex(o=>o.descriptor.objectId===p.afterObjectId);if(index<0)fail();start=p.afterChunkIndex===null?index+1:index;chunk=p.afterChunkIndex===null?0:Number(p.afterChunkIndex);}
  let rangesLeft=j.description.selection.limits.maxRangesPerPage,next:Row|null=null;
  for(let i=start;i<all.length&&items.length<limit;i++){
   const o=all[i]!,d=o.descriptor;let state='APPLIED',ranges:number[][]=[];
   if(!o.receipt){const status=await this.ports.chunks.status(j.lease as unknown as ObjectLease,nativeObject(d));state=status.state;for(const n of status.missing.filter(n=>n>=chunk)){const tail=ranges[ranges.length-1];if(tail&&tail[1]===n)tail[1]=n+1;else ranges.push([n,n+1]);}}
   const take=ranges.slice(0,rangesLeft);rangesLeft-=take.length;items.push({objectId:d.objectId,state,missingRanges:take,receipt:o.receipt});chunk=0;
   if(take.length<ranges.length){if(!take.length){items.pop();next={afterObjectId:d.objectId,afterChunkIndex:ranges[0]![0]};}else next={afterObjectId:d.objectId,afterChunkIndex:take[take.length-1]![1]};break;}
   next=i+1<all.length?{afterObjectId:d.objectId,afterChunkIndex:null}:null;
   if(rangesLeft===0)break;
  }
  return {...base,items,next,done:next===null};
 }
 private async runnable(j:Job,d:ObjectDescriptor){for(const dep of d.dependsOn)if(!(await this.ports.store.object(j,dep)).receipt)fail('DEPENDENCIES_PENDING');}
 private receiverSlotsFor(s:Selection){return this.bindings.length===2?Math.ceil(s.limits.maxInFlightObjects/2):s.limits.maxInFlightObjects;}
 private receiverSlots(j:Job){return this.receiverSlotsFor(j.description.selection);}
 private admit(j:Job,d:ObjectDescriptor){
  if(this.activeReceive.has(d.objectId))return;
  if(this.activeReceive.size>=this.receiverSlots(j))fail('WINDOW_FULL');this.activeReceive.add(d.objectId);
 }
 private async apply(j:Job,r:Envelope):Promise<Row>{
  if(j.state==='PLANNING')fail('MANIFEST_INCOMPLETE');const o=await this.ports.store.object(j,String(r.payload!.objectId));if(o.receipt){if(o.receipt.applyRequestId!==r.requestId||o.receipt.applyRequestDigest!==r.requestDigest)fail('REQUEST_CONFLICT');await this.ports.store.db.transaction([this.ports.store.guard(j),...this.ports.store.bind(j,this.ports.phoneDeviceId,r)]);await this.cleanupApplied(j,o.descriptor);return {state:'APPLIED',receipt:o.receipt};}
  if(terminal(j))fail('JOB_CANCELLED');await this.runnable(j,o.descriptor);await this.admit(j,o.descriptor);
  const final=await (this.ports.publish?this.ports.publish(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),o.descriptor,j):this.ports.chunks.finalize(j.lease as unknown as ObjectLease,nativeObject(o.descriptor)));this.check();
  await this.ports.apply(j,o.descriptor,final.path,this.ports.store.boundary(j,r,this.ports.phoneDeviceId,o.descriptor.objectId,this.ports.watchDeviceId,()=>this.check()));this.check();
  const saved=await this.ports.store.object(j,o.descriptor.objectId);if(!saved.receipt)fail('RECEIPT_CONFLICT');
  this.receive?.index?.didApply(o.descriptor.objectId);
  // Business commit is authoritative. Cleanup is repeatable and cannot revoke it.
  try{await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),!['noteAsset','readerResource','bookPackageSegment'].includes(o.descriptor.kind));}catch{}
  this.activeReceive.delete(o.descriptor.objectId);this.ports.recovery?.confirm('APPLIED','phoneToWatch:'+o.descriptor.objectId);this.ports.applied?.(o.descriptor.kind);return {state:'APPLIED',receipt:saved.receipt};
 }
 private makeRequest(phase:Envelope['phase'],job:string,plan:string,epoch:number|null,payload:Row,stable=true):Envelope{const digest=requestDigest(job,plan,phase,payload),id=stable?D('wrss.library-binary.v2/source-request',[job,digest]).slice(0,32):'';return {action:ACTION,version:VERSION,phase,type:'request',jobId:job,planDigest:plan,epoch,requestId:id,requestDigest:digest,payload};}
 private async request(phase:Envelope['phase'],job:string,plan:string,epoch:number|null,payload:Row,stable=true):Promise<Envelope>{
  const r=this.makeRequest(phase,job,plan,epoch,payload,stable);if(!stable)r.requestId=await this.ports.randomId();
  for(;;){this.check();const light=phase==='missing'&&payload.limit===0;this.slots!.begin(r,{authenticated:true,beginAuthorized:!!this.sourceEpoch,admitted:phase!=='manifestPage',state:'READY',nextManifestPage:0,expiresAtMillis:0});
   let deadline:{cancel():void}|undefined;const answer=new Promise<Envelope>((resolve,reject)=>this.pending.set(r.requestId,{request:r,resolve,reject}));void answer.catch(()=>{});
   try{await this.write(r,()=>{if(light||!this.sourceEpoch||!['manifestPage','apply','missing','complete'].includes(phase)){const timer=this.ports.sleep(30000);deadline=timer;void timer.result.then(()=>this.close(Error('SocketTimeout')),()=>{});}});const result=await answer;
    if(!result.success){const error=new ResumeError(String(result.error!.code));this.stateBucket.take(this.ports.now());if(error.wire().recovery==='WAIT'){await this.ports.sleep(this.backoff.next(Number(result.error!.retryAfterMillis))).result;continue;}throw error;}
    if(['manifestPage','apply'].includes(phase))this.backoff.reset();return result;
   }finally{deadline?.cancel();}
  }
 }
 private wakeData(){this.dataWake?.();}
 private failData(error:unknown){
  if(!this.dataFailure||this.dataFailure instanceof ResumeError&&this.dataFailure.wire().recovery==='QUERY')this.dataFailure=error;
  this.wakeData();
 }
 private async waitData(milliseconds?:number){
  const timer=milliseconds===undefined?undefined:this.ports.sleep(milliseconds);
  try{
   const change=new Promise<void>(resolve=>{this.dataWake=resolve;});
   if(timer)await Promise.race([change,timer.result]);else await change;
  }finally{this.dataWake=undefined;timer?.cancel();}
 }
 private *chunks(objects:readonly {descriptor:ObjectDescriptor;missing:number[][]}[],all:readonly ObjectDescriptor[]){
  const slots=new Map(all.map((d,slot)=>[d.objectId,slot]));
  for(const {descriptor,missing} of objects){
   const slot=slots.get(descriptor.objectId)!;
   for(const [from,to] of missing)for(let index=from;index<to;index++)yield {slot,index};
  }
 }
 private async sendChunks(source:BinarySourcePlan,local:Job,objects:readonly {descriptor:ObjectDescriptor;missing:number[][]}[]){
  const send=this.send!,indices=this.chunks(objects,source.objects);
  let next=indices.next(),ahead=indices.next();
  let prefetch:{slot:number;index:number;file:Promise<SourceFileChunk>}|undefined;
  const readFile=async(d:ObjectDescriptor,index:number)=>{
   const range=source.range?.(d,index);
   if(!range||!this.io.prepareFile)fail('CAPABILITY_MISMATCH');
   this.sourceReading=true;this.workUnit();
   try{return await this.io.prepareFile(range);}finally{this.sourceReading=false;this.workUnit();}
  };
  try{for(;;){
   this.check();
   if(this.dataFailure){
    if(this.dataFailure instanceof ResumeError&&this.dataFailure.wire().recovery==='QUERY'&&send.window.credit.chunks){
     await this.waitData();continue;
    }
    throw this.dataFailure;
   }
   const retry=this.retries[0],item=retry?{slot:retry.pending.objectSlot,index:retry.pending.chunkIndex}:next.value;
   if(!item){
    if(!send.window.credit.chunks)return;
    await this.waitData();continue;
   }
   const {slot,index}=item,d=source.objects[slot]!,length=Math.min(65536,d.size-index*65536);
   if(!send.window.canSend(length)){await this.waitData();continue;}
   if(retry&&retry.due>this.ports.now()){await this.waitData(retry.due-this.ports.now());continue;}
   let bytes:Uint8Array|SourceFileChunk;
   try{
    if(d.kind.startsWith('book')){
     if(prefetch?.slot===slot&&prefetch.index===index){
      const file=prefetch.file;prefetch=undefined;bytes=await file;
     }else bytes=await readFile(d,index);
     if(bytes.length!==length)fail('SOURCE_CHANGED');
    }else{
     bytes=await this.readSource(source,d,index);
     if(bytes.length!==length||hash(bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');
    }
   }catch(e){
    this.ports.diagnostic?.(e);const error=resumeError(e);if(error.code!=='SOURCE_CHANGED')throw error;
    await this.request('cancel',local.jobId,local.planDigest,local.epoch,{reason:'SOURCE_CHANGED'});
    await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));throw error;
   }
   const digest=requestDigest(local.jobId,local.planDigest,'putChunk',{objectId:d.objectId,chunkIndex:index});
   const id=D('wrss.library-binary.v2/source-request',[local.jobId,digest]).slice(0,32);
   let sent=false;
   try{
    const written=this.binary.writeData(()=>{
    if(this.dataFailure)return null;
    this.check();sent=true;
    return send.window.reserve({objectSlot:slot,chunkIndex:index,requestId:id,requestDigest:digest,payload:bytes});
    });
    if(!retry&&!prefetch&&!ahead.done){
     const following=source.objects[ahead.value.slot]!;
     if(following.kind.startsWith('book')){
      const file=readFile(following,ahead.value.index);void file.catch(()=>{});
      prefetch={...ahead.value,file};
     }
    }
    await written;
   }finally{if(!sent&&!(bytes instanceof Uint8Array))await this.io.dropFile?.(bytes).catch(()=>{});}
   if(sent){if(retry)this.retries.shift();else {next=ahead;ahead=indices.next();}}
  }}finally{if(prefetch)await prefetch.file.then(file=>this.io.dropFile?.(file)).catch(()=>{});}
 }
 private async sendSource(b:Binding):Promise<void>{

  for(;;){try{await this.transferSource(b);await this.finishIfTerminal();return;}catch(e){if(!(e instanceof ResumeError))throw e;const recovery=String(e.wire().recovery);if(recovery==='WAIT'){await this.ports.sleep(100).result;this.check();continue;}if(!['BEGIN','QUERY'].includes(recovery))throw e;this.check();b={...b,intent:'resume'};}}
 }
 private async transferSource(b:Binding):Promise<void>{
  const o=this.selectedOffer!,old=await this.ports.store.job(this.scope,b.jobId);let source:BinarySourcePlan|undefined,p:BeginPayload;
  if(b.intent==='resume'){if(!old)fail('NOT_FOUND');p={...old.description,intent:'resume'};}
  else{source=this.preparedSource??await this.ports.source(o.watchSnapshot,b.selection);validateGraph(source.objects);const counts:number[]=[];let bytes=0,count=0;
   const pageBytes=Math.min(b.selection.limits.maxManifestPageBytes,b.selection.limits.maxFrameBytes);for(const object of source.objects){const n=utf8(JSON.stringify(object)).length;if(n+4096>pageBytes)fail('LIMIT_EXCEEDED');if(count&&(bytes+n+4096>pageBytes||count===b.selection.limits.maxManifestPageEntries)){counts.push(count);count=0;bytes=0;}count++;bytes+=n;}if(count)counts.push(count);
   p={intent:'create',accountScope:this.ports.accountScope,phoneDeviceId:this.ports.phoneDeviceId,watchDeviceId:this.ports.watchDeviceId,direction:'watchToPhone',phoneSnapshot:o.payload.phoneSnapshot as unknown as Snapshot,watchSnapshot:o.watchSnapshot,selection:b.selection,selectionDigest:selectionDigest(b.selection),objectCount:source.objects.length,objectsRoot:objectsRoot(source.objects.map(v=>v.objectId)),pageObjectCounts:counts};
  }
  this.sourceEpoch=undefined;await this.sourceHeartbeat?.catch(()=>{});this.sourcePlans.set(b.jobId,p);const plan=planDigest(p);this.slots=new ControlSlots({streamId:2,jobId:b.jobId,planDigest:plan,selectionDigest:p.selectionDigest},this.ports.phoneDeviceId);const beginId=D('wrss.library-binary.v2/source-request',[b.jobId,requestDigest(b.jobId,plan,'begin',p as unknown as Row)]).slice(0,32);
  const fake:Envelope={action:ACTION,version:VERSION,phase:'begin',type:'request',jobId:b.jobId,planDigest:plan,epoch:null,requestId:beginId,requestDigest:requestDigest(b.jobId,plan,'begin',p as unknown as Row),payload:p as unknown as Row};
  // Persist source intent BEFORE sending a begin that the receiver may commit.
  let local=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.begin(this.scope,fake,p,this.ports.connectionId,old?.epoch??1,null,'source')));
  const began=await this.request('begin',b.jobId,plan,null,p as unknown as Row),epoch=Number(began.epoch),beginResult=began.result!;
  if(!Number.isSafeInteger(epoch)||epoch<1||beginResult.selectionDigest!==p.selectionDigest)fail('CAPABILITY_MISMATCH');
  local=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.begin(this.scope,fake,{...p,intent:'resume'},this.ports.connectionId,epoch,null,'source')));
  this.sourceEpoch={job:b.jobId,plan,epoch,last:this.ports.now()};
  if(this.send)this.send.job=local;
  else this.send={job:local,window:new SendWindow(this.binding(local),epoch,this.ports.now(),this.binary.staleAckBudget,p.selection.limits)};
  this.dataFailure=undefined;this.retries.length=0;
  if(beginResult.state==='CANCELLED'){await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));fail('JOB_CANCELLED');}
  if(local.state==='CANCELLED'){await this.request('cancel',b.jobId,plan,epoch,{reason:'USER_CANCEL'});fail('JOB_CANCELLED');}
  if(beginResult.state==='COMPLETE'){await this.acceptCompletion(local,beginResult.completion as unknown as Completion);return;}
  if(b.selection.limits.maxInFlightObjects===1&&this.bindings.length===2){const forward=this.bindings.find(x=>x.direction==='phoneToWatch')!;for(;;){this.check();const j=await this.ports.store.job(this.scope,forward.jobId);if(j?.state==='COMPLETE'&&this.settled.has(forward.jobId))break;if(j?.state==='CANCELLED')fail('JOB_CANCELLED');await this.ports.sleep(100).result;}}
  try{source??=await this.ports.source(o.watchSnapshot,b.selection);}catch(e){const error=resumeError(e);if(error.code!=='SOURCE_CHANGED')throw error;await this.request('cancel',b.jobId,plan,epoch,{reason:'SOURCE_CHANGED'});await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));throw new ResumeError('SOURCE_CHANGED');}
  if(objectsRoot(source.objects.map(v=>v.objectId))!==p.objectsRoot)fail('SOURCE_CHANGED');this.sourceDescriptions.set(b.jobId,source.objects);
  let start=0,previous='0'.repeat(64);for(let index=0;index<p.pageObjectCounts.length;index++){
   const entries=source.objects.slice(start,start+p.pageObjectCounts[index]!);const digest=pageDigest(plan,index,start,entries,previous),payload={pageIndex:index,startIndex:start,previousPageDigest:previous,pageDigest:digest,entries};
   if(index>=Number(beginResult.nextManifestPage))await this.request('manifestPage',b.jobId,plan,epoch,payload);start+=entries.length;previous=digest;
  }
  // Re-query the receiver on every recovery. Bytes sent are never receipts.
  const observed=new Map<string,{descriptor:ObjectDescriptor;state:string;missing:number[][];receipt:AppliedReceipt|null}>();let cursor:Row={afterObjectId:null,afterChunkIndex:null,limit:b.selection.limits.maxResultsPerPage};
  for(;;){const result=(await this.request('missing',b.jobId,plan,epoch,cursor,false)).result!;for(const raw of result.items as Row[]){const d=source.objects.find(v=>v.objectId===raw.objectId);if(!d)fail('RECEIPT_CONFLICT');const item=observed.get(d.objectId)??{descriptor:d,state:String(raw.state),missing:[],receipt:null};item.missing.push(...raw.missingRanges as number[][]);item.receipt=raw.receipt as unknown as AppliedReceipt|null;observed.set(d.objectId,item);}if(result.done===true)break;cursor={...row(result.next),limit:b.selection.limits.maxResultsPerPage};}
  const partial=(d:ObjectDescriptor)=>['PARTIAL','STAGED'].includes(observed.get(d.objectId)?.state??'');
  const applied=new Map<string,AppliedReceipt>();for(const [id,v]of observed)if(v.receipt){this.validateReceipt(v.receipt,b.jobId,plan,id);applied.set(id,v.receipt);}
  while(applied.size<source.objects.length){
   const ready=source.objects.filter(d=>!applied.has(d.objectId)&&d.dependsOn.every(id=>applied.has(id))).sort((a,b)=>Number(partial(b))-Number(partial(a))||(a.objectId<b.objectId?-1:1));if(!ready.length)fail('PLAN_CONFLICT');
   const maximum=b.selection.limits.maxInFlightObjects;
   const slots=this.bindings.length===1?maximum:Math.max(1,Math.floor(maximum/2));
   const active=ready.slice(0,slots);
   await this.sendChunks(source,local,active.map(d=>{
    const entry=observed.get(d.objectId);if(!entry)fail('RECEIPT_CONFLICT');return entry;
   }));
   for(const d of active){
    const result=(await this.request('apply',b.jobId,plan,epoch,{objectId:d.objectId})).result!,receipt=result.receipt as unknown as AppliedReceipt;this.validateReceipt(receipt,b.jobId,plan,d.objectId);this.ports.recovery?.confirm('APPLIED','watchToPhone:'+d.objectId);await this.ports.store.touch(local);applied.set(d.objectId,receipt);
   }
  }
  const root=receiptsRoot(source.objects.map(d=>applied.get(d.objectId)!));const done=(await this.request('complete',b.jobId,plan,epoch,{objectCount:p.objectCount,receiptsRoot:root,ackToInclusive:p.watchSnapshot.toInclusive})).result as unknown as Completion;if(done.receiptsRoot!==root)fail('RECEIPT_CONFLICT');await this.acceptCompletion(local,done);
 }
 private async readSource(source:BinarySourcePlan,object:ObjectDescriptor,index:number){
  this.sourceReading=true;this.workUnit();
  try{return await source.read(object,index);}finally{this.sourceReading=false;this.workUnit();}
 }
 private validateAnswer(answer:Envelope,request:Envelope):void {
  const o=answer.result!,p=request.payload!;
  const descriptors=this.sourceDescriptions.get(request.jobId!)??[],description=this.sourcePlans.get(request.jobId!);
  if(description&&o.completion){const c=o.completion as unknown as Completion;if(c.objectCount!==description.objectCount||c.ackToInclusive!==description.watchSnapshot.toInclusive||c.completionDigest!==completion(request.jobId!,request.planDigest!,c.objectCount,c.receiptsRoot,c.ackToInclusive).completionDigest)fail('RECEIPT_CONFLICT');}
  const receipt=(value:unknown,id:string)=>this.validateReceipt(value as AppliedReceipt,request.jobId!,request.planDigest!,id);
  switch(request.phase){
   case 'prepare':if(o.step!==p.step||p.step==='confirm'&&o.preparationDigest!==p.preparationDigest)fail();break;
   case 'begin':{const d=p as unknown as BeginPayload;if(o.selectionDigest!==d.selectionDigest||Number(o.nextManifestPage)>d.pageObjectCounts.length||d.intent==='resume'&&o.disposition==='CREATED')fail();if(o.state==='COMPLETE'){const c=o.completion as unknown as Completion;if(c.objectCount!==d.objectCount||c.ackToInclusive!==d.watchSnapshot.toInclusive)fail('RECEIPT_CONFLICT');}break;}
   case 'manifestPage':if(o.pageIndex!==p.pageIndex||o.pageDigest!==p.pageDigest||o.nextManifestPage!==Number(p.pageIndex)+1)fail();break;
   case 'missing':{
    const local=this.bindings.find(b=>b.jobId===request.jobId)!.selection.limits,items=o.items as Row[];if(items.length>Number(p.limit)||Number(p.limit)===0&&(items.length||o.next!==null||!o.done)||Number(p.limit)>0&&o.state==='PLANNING')fail();let ranges=0;
    for(const item of items){const d=descriptors.find(d=>d.objectId===item.objectId);if(!d)fail('RECEIPT_CONFLICT');for(const range of item.missingRanges as number[][]){ranges++;if(range[1]!>d.chunkHashes.length)fail();}if(item.receipt)receipt(item.receipt,d.objectId);}if(ranges>local.maxRangesPerPage||items.length>local.maxResultsPerPage||Number(o.nextManifestPage)>(description?.pageObjectCounts.length??0))fail();if(o.next){const cursor=row(o.next),d=descriptors.find(d=>d.objectId===cursor.afterObjectId);if(!d||cursor.afterChunkIndex!==null&&Number(cursor.afterChunkIndex)>=d.chunkHashes.length)fail();}break;
   }
   case 'putChunk':fail();
   case 'apply':receipt(o.receipt,String(p.objectId));break;
   case 'complete':if(o.objectCount!==p.objectCount||o.receiptsRoot!==p.receiptsRoot||o.ackToInclusive!==p.ackToInclusive)fail('RECEIPT_CONFLICT');break;
   case 'cancel':break;
  }
 }
 private validateReceipt(r:AppliedReceipt,job:string,plan:string,id:string){exact(r,['jobId','planDigest','objectId','applyRequestId','applyRequestDigest','receiverDeviceId','resultDigest','outcome']);if(r.jobId!==job||r.planDigest!==plan||r.objectId!==id||r.receiverDeviceId!==this.ports.phoneDeviceId||!['merged','retainedLocal','alreadyPresent'].includes(r.outcome)||r.resultDigest!==D('wrss.library-binary.v2/applied',[r.jobId,r.planDigest,r.objectId,hex(r.applyRequestId,32),hex(r.applyRequestDigest),r.receiverDeviceId,r.outcome]))fail('RECEIPT_CONFLICT');}
 private async acceptCompletion(j:Job,c:Completion){this.settled.add(j.jobId);this.ports.recovery?.confirm('COMPLETE','watchToPhone:'+j.description.objectsRoot);if(!c||c.state!=='COMPLETE'||c.objectCount!==j.description.objectCount||c.ackToInclusive!==j.description.watchSnapshot.toInclusive||c.completionDigest!==completion(j.jobId,j.planDigest,c.objectCount,c.receiptsRoot,c.ackToInclusive).completionDigest)fail('RECEIPT_CONFLICT');await this.ports.authorize(()=>this.ports.store.exclusive(async()=>{const latest=await this.ports.store.job(j.scope,j.jobId);if(!latest||latest.connectionId!==this.ports.connectionId||latest.epoch!==j.epoch)fail('STALE_EPOCH');await this.ports.store.db.transaction([this.ports.store.guard(j),{sql:"UPDATE library_binary_jobs SET state='COMPLETE',completion=? WHERE scope=? AND job_id=?",params:[JSON.stringify(c),j.scope,j.jobId]},{sql:'INSERT OR REPLACE INTO library_binary_peer_ack VALUES(?,?,?)',params:[j.scope,j.jobId,JSON.stringify(c)]},{sql:'DELETE FROM library_binary_reservations WHERE scope=? AND job_id=?',params:[j.scope,j.jobId]}]);}));}
}
