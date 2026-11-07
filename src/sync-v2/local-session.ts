/** Opt-in adapter for an EXISTING authenticated v13/v14 connection. */
import {FramingBoundary} from '@podjs/framework/framing-boundary';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
import type {SyncFrameConnection} from '../sync/session';
import {LocalProofSession,checkedFeatures} from './local-proof';
import {checkedCapability,objectCapability,chooseLocalProtocol,type ObjectCapability} from './local-capability';
import {exact,canonical,hexId,uint,type Scope} from './protocol';
import {sameScope,sorted} from './wire';
import {localObjectFrames,LocalReadService,localRequest,localResponse,localFailure} from './local-read';
import {partBody,anyObjectOid,type LocalObjectStore} from './local-objects';
import type {PeerCustodyStore} from './peer-custody';
import type {LocalWitnessStore} from './witness';
import {LocalReadWindows,type LocalWindowSnapshot} from './local-window';
import {LocalTreeDiff} from './local-tree';
export interface LocalSessionOptions {
 enabled?:boolean;proof:LocalProofSession;requiredFeatures:string[];supportedFeatures:string[];
 objects:LocalObjectStore;nonce:()=>Promise<string>;
 closeSocket:()=>Promise<void>;custody?:PeerCustodyStore;witness?:LocalWitnessStore;
 snapshot:()=>Promise<LocalWindowSnapshot>;now?:()=>number;
 /** These ports reuse the cloud's authenticated semantics and business CAS. */
 treeDiff?:(body:any)=>Promise<any>;refUpdate?:(body:any)=>Promise<any>;demand?:(body:any)=>Promise<any>;
}
export class WatchLocalObjectSession {
 readonly capability:ObjectCapability;readonly boundary:FramingBoundary;
 private remote?:ObjectCapability;private negotiationFailed=false;
 private frames?:ReturnType<typeof localObjectFrames>;
 private scope:Scope;
 private windows:LocalReadWindows;
 constructor(private readonly options:LocalSessionOptions){this.scope=options.proof.hello.scope;sameScope(options.objects.scope,this.scope);if(options.custody&&(options.custody.claimant!==options.proof.hello.deviceId||canonical(options.custody.scope)!==canonical(this.scope)))throw Error('scope_mismatch');if(canonical(options.proof.hello.features)!==canonical(options.supportedFeatures))throw Error('feature_missing');this.capability=objectCapability(this.scope,options.enabled===true,options.requiredFeatures,options.supportedFeatures);this.boundary=new FramingBoundary(options.proof.sessionId,()=>options.enabled===true&&options.proof.verified,options.closeSocket);if(typeof options.snapshot!=='function')throw Error('feature_missing');this.windows=new LocalReadWindows(this.scope,()=>options.proof.verified,options.snapshot,options.nonce,options.now);}
 private async current(){try{await this.options.proof.assertCurrent();}catch(error){this.windows.close();this.negotiationFailed=true;throw error;}}
 private async readWindow(id:string){await this.current();this.windows.check(id);}
 private async negotiateWindow(body:any){
  await this.current();exact(body,['scope','knownRefs','features']);sameScope(body.scope,this.scope);const features=checkedFeatures(body.features),peer=this.options.proof.peerFeatures;
  if(features.some(f=>!this.options.proof.hello.features.includes(f)||!peer.includes(f)))throw Error('feature_missing');
  const result=await this.windows.issue(body.knownRefs,features);await this.current();return result;
 }
 /** Called only inside the existing read-only probe handler. */
 async probe(request:any){
  if(this.options.enabled!==true)return {};
  this.remote=undefined;if(request.supportsSyncObjectsV2===true){const fields=['supportsSyncObjectsV2','syncObjectsVersions','requiredFeatures','supportedFeatures','scope','maxPartBytes'];try{this.remote=checkedCapability(Object.fromEntries(fields.map(k=>[k,request[k]])));}catch{}}
  return {...this.capability};
 }
 private check(){if(this.negotiationFailed||!this.boundary.enabled||!this.options.proof.verified)throw Error('proof_invalid');}
 async handle(request:any,connection:SyncFrameConnection):Promise<boolean>{
  const {options:o}=this;localRequest(request);const {requestId,body,action}=request;
  const respond=(value:any)=>connection.writeFrame(localResponse(requestId,value));
  if(o.enabled!==true||!this.remote?.supportsSyncObjectsV2||this.negotiationFailed){await connection.writeFrame(localFailure(requestId,'feature_disabled'));return false;}
  if(action==='syncObjectsV2.negotiate'){
   if(o.proof.verified&&body?.knownRefs!==undefined){try{await respond(await this.negotiateWindow(body));}catch(e){try{await connection.writeFrame(localFailure(requestId,(e as Error).message));}finally{if(this.negotiationFailed)await this.close();}}return false;}
   try{
    sameScope(this.remote.scope!,this.scope);
    if(chooseLocalProtocol({legacyMax:14,capability:this.capability},{legacyMax:14,capability:this.remote},true,false)!=='objects-v2')throw Error('feature_missing');
    if(body?.proof!==undefined){exact(body,['scope','proof']);sameScope(body.scope,this.scope);await o.proof.verify(body.proof,[...new Set([...o.requiredFeatures,...this.remote.requiredFeatures])].sort());await respond({scope:this.scope,proof:o.proof.proof()});}
    else {if(canonical(body?.features)!==canonical(this.remote.supportedFeatures))throw Error('feature_missing');await respond(await o.proof.negotiate(body));}
   }catch(e){this.negotiationFailed=true;o.proof.close();await connection.writeFrame(localFailure(requestId,(e as Error).message));}return false;
  }
  if(!o.proof.verified){await connection.writeFrame(localFailure(requestId,'proof_invalid'));return false;}
  try{await this.current();}catch(e){try{await connection.writeFrame(localFailure(requestId,(e as Error).message));}finally{await this.close();}return false;}
  if(action==='syncObjectsV2.prepareFraming'){await this.boundary.prepare(body,respond);return false;}
  if(action!=='syncObjectsV2.commitFraming'){await connection.writeFrame(localFailure(requestId,'feature_disabled'));return false;}
  // Detach is allowed only after the complete committed response was written.
  if(typeof(connection as any).detachStream!=='function'){await this.close();throw Error('framing_handoff_unavailable');}
  await this.boundary.commit(body,respond);this.frames=localObjectFrames((connection as SyncFrameConnection&{detachStream():FrameByteStream}).detachStream(),this.scope,o.proof.sessionId,()=>this.boundary.enabled);
  await this.serve();return true;
 }
 /** Also useful for a caller-owned host/LAN harness after real old-frame
  * negotiation. The same dispatcher runs in the product session adapter. */
 async serve(){
  const frames=this.frames;if(!frames)throw Error('framing_not_committed');const o=this.options,read=new LocalReadService(o.objects,this.scope,o.proof.sessionId,id=>this.readWindow(id),o.nonce,async()=>{this.check();await this.current();});
  const tree=new LocalTreeDiff(o.objects,this.scope,id=>this.readWindow(id),o.nonce);
  try{for(;;){this.check();const frame=await frames.read(120000);if(frame.kind!=='control')throw Error('unexpected_data_frame');const request=localRequest(frame.value),{body:b,action,requestId}=request;
    try{
     await this.current();
     if(['syncObjectsV2.objectGet','syncObjectsV2.stateRefsGet','syncObjectsV2.recipeRefsGet'].includes(action)){await read.read(request,frames);continue;}
     let result:any;
     if(action==='syncObjectsV2.receipt'){
      if(b?.kind==='custody'){exact(b,['kind','custody']);if(!o.custody)throw Error('feature_disabled');const receipt=await o.custody.accept(b.custody,o.proof);result={pinId:receipt.body.pinId,state:receipt.state,result:receipt};}
      else {exact(b,['kind','oid','durableOffset','totalBytes']);if(b.kind!=='local')throw Error('invalid_schema');anyObjectOid(b.oid);uint(b.totalBytes,266264);if(uint(b.durableOffset)>b.totalBytes)throw Error('offset_conflict');
       // A local receipt is a resume hint in its own peer namespace. It never
       // reaches cloud receipt verification or the cleanup authorizer.
       const id='local-peer-receipt:'+o.proof.peerDeviceId+':'+b.oid,prior=await o.objects.store.get(id);if(prior&&(prior.value.totalBytes!==b.totalBytes||prior.value.durableOffset>b.durableOffset))throw Error('offset_conflict');await o.objects.store.put(id,JSON.parse(canonical(b)),prior?.revision??null);result={accepted:true};}
     }else if(action==='syncObjectsV2.refUpdate'){
      // C29 publication envelopes retain the cloud's original author signatures.
      if(b?.account!==undefined){exact(b,['account','device','relayGrant']);for(const signed of [b.account,b.device,b.relayGrant])sameScope(signed?.body?.scope,this.scope);}
      else sameScope(b?.body?.scope,this.scope);
      if(!o.refUpdate)throw Error('feature_disabled');result=await o.refUpdate(b);
     }else{
      sameScope(b?.scope,this.scope);
      if(action==='syncObjectsV2.negotiate'){result=await this.negotiateWindow(b);}
      else if(action==='syncObjectsV2.haveWant'){exact(b,['scope','windowId','oids']);hexId(b.windowId,32);await this.readWindow(b.windowId);sorted(b.oids,512,anyObjectOid);const objects=[];for(const id of b.oids){this.check();objects.push(await o.objects.status(id));}result={scope:this.scope,windowId:b.windowId,objects};}
      else if(action==='syncObjectsV2.putPart'){partBody(b,this.scope);const part=await frames.read(10000);this.check();await this.current();if(part.kind!=='part')throw Error('unexpected_control_frame');result=await o.objects.part(b,part.header,part.payload,o.proof.sessionId);}
      else if(action==='syncObjectsV2.complete'){exact(b,['scope','transferId','oid','totalBytes']);hexId(b.transferId,32);result=await o.objects.complete(b.oid,b.totalBytes);}
      else if(action==='syncObjectsV2.witness'){if(!o.witness)throw Error('feature_disabled');result=await o.witness.receive(b,o.proof);}
      else if(action==='syncObjectsV2.treeDiff'){hexId(b.windowId,32);await this.readWindow(b.windowId);result=await(o.treeDiff?o.treeDiff(b):tree.diff(b));}
      else if(action==='syncObjectsV2.demand'){if(!o.demand)throw Error('feature_disabled');result=await o.demand(b);}
      else throw Error('unknown_action');
     }
     this.check();await this.current();await frames.writeControl(localResponse(requestId,result));
    }catch(e){if(!this.negotiationFailed)this.check();await frames.writeControl(localFailure(requestId,(e as Error).message));if(this.negotiationFailed)return;}
   }
  }finally{await this.close();}
 }
 async close(){this.windows.close();this.options.proof.close();try{await this.frames?.close();}finally{await this.boundary.close();}}
}
export function watchLocalObjectsV2(options:LocalSessionOptions){return options.enabled===true?new WatchLocalObjectSession(options):null;}
