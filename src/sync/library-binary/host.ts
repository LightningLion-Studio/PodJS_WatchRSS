import config from '../../../pod.config.json';
import type {WatchAccountStore} from '../../account/store';
import type {WatchAccountState} from '../../account/types';
import type {SyncActionContext,SyncFrameConnection} from '../session';
import type {SyncByteStream} from '../stream';
import type {VerifiedChunkStore,ObjectLease} from '@podjs/framework/verified-chunk-store';
import {BinaryStore} from './store';
import {BinaryAssets,type BinaryAssetFiles} from './assets';
import {BinaryByteTransport} from './transport';
import {LibraryBinaryConnection} from './coordinator';
import {SwitchGate,s2Capability,RELEASE_B2_ENABLED} from './routing';
import {RecoveryRules} from './recovery';
import {D} from './digests';
import {HARD_LIMITS,ResumeError,fail,text,type Row,type Capability} from './wire';
export interface BinarySessionPort {
 probe(request:Row,context:SyncActionContext):Promise<Row>;
 accountConfirmed(request:Row,context:SyncActionContext):Promise<void>;
 run(request:Row,connection:SyncFrameConnection,context:SyncActionContext):Promise<void>;
 failed?(error:unknown,context?:SyncActionContext):unknown;
 business?(context:SyncActionContext):void;
}
interface Negotiation {peer:string;capability:Capability;account?:WatchAccountState;business:boolean;connectionId:string;running:boolean}
export interface BinaryApplicationPorts {
 b2Enabled?:boolean;byteBridge():boolean;localPermission():boolean;store:BinaryStore;chunks:VerifiedChunkStore;files:BinaryAssetFiles;
 account:WatchAccountStore;deviceId():Promise<string>;randomId():Promise<string>;now():number;
 sampleClock?():Promise<void>;
 sleep(milliseconds:number):{result:Promise<void>;cancel():void};changed?():void;
 /** Native listener identity is fixed per accepted stream. */
 recovery?:RecoveryRules;
}
/** RFCOMM only. There is no capability, table creation or file I/O when off. */
export class BinaryApplicationService implements BinarySessionPort {
 private readonly sessions=new WeakMap<object,Negotiation>();
 private recovery:RecoveryRules;
 private reconnected=false;
 constructor(private readonly ports:BinaryApplicationPorts){this.recovery=ports.recovery??new RecoveryRules();}
 private enabled(){return (this.ports.b2Enabled??RELEASE_B2_ENABLED)&&this.ports.byteBridge()&&this.ports.localPermission();}
 canSwitch(){return this.enabled();}
 async probe(r:Row,context:SyncActionContext):Promise<Row>{
  this.sessions.delete(context.session);if(!this.enabled())return {};
  if(r.supportedLibraryBinaryVersions===undefined)return {};
  const versions=r.supportedLibraryBinaryVersions;if(!Array.isArray(versions)||versions.some(v=>!Number.isSafeInteger(v)||v<1)||new Set(versions).size!==versions.length)fail('CAPABILITY_MISMATCH');if(!versions.includes(2))return {};
  const peer=text(r.deviceId,128),runtime=await this.ports.chunks.runtime();if(!runtime)fail('CAPABILITY_MISMATCH');
  await this.ports.sampleClock?.();await this.ports.store.initialize();await this.ports.store.observeClock(runtime.elapsedMillis);
  const cap=s2Capability([{kind:'noteAsset',schemaVersion:1,send:true,receive:true}],{...HARD_LIMITS,maxObjectBytes:Math.min(5242880,runtime.maxObjectBytes),maxPlanObjects:512,maxManifestBytes:262144,maxMetadataBytes:1024,maxJournalBytes:33554432,maxInFlightObjects:Math.min(4,runtime.maxInFlightObjects),maxStagingBytes:Math.min(134217728,runtime.maxStagingBytes),maxInFlightChunks:1,maxInFlightBytes:65536});
  if(this.recovery.snapshot.stopped&&!this.reconnected)this.recovery=new RecoveryRules();this.sessions.set(context.session,{peer,capability:cap,business:false,connectionId:await this.ports.randomId(),running:false});return {libraryPeer:{implementation:'podjs',appVersion:config.versionName},libraryBinary:cap};
 }
 business(context:SyncActionContext){const n=this.sessions.get(context.session);if(n)n.business=true;}
 async accountConfirmed(r:Row,context:SyncActionContext){const n=this.sessions.get(context.session);if(!n)return;const account=await this.ports.account.read();if(!account||!r.account||(r.account as Row).userId!==account.userId||r.deviceId!==undefined&&r.deviceId!==n.peer)fail('ACCOUNT_MISMATCH');n.account=account;this.recovery.accountReady(n.connectionId,this.reconnected);}
 failed(error:unknown,context?:SyncActionContext):unknown {
  const e=error as Error&{code?:string;b2Handled?:boolean;stopAutomaticRecovery?:boolean};if(e?.b2Handled)return e;
  const n=context?this.sessions.get(context.session):undefined;if(!n&&!this.reconnected)return error;
  if(e instanceof ResumeError&&['SOURCE_CHANGED','NOT_FOUND','EXPIRED'].includes(e.code)&&n?.running){this.recovery.detach(n.connectionId);return Object.assign(e,{b2Handled:true,stopAutomaticRecovery:false,routeHandoff:true});}
  const cause=e?.message;const io=['EOF','closed','reset','SocketTimeout','Truncated sync stream','Sync frame read timed out'].includes(cause)||e?.code==='host_error'&&/timed out|[Ss]ocket closed|Connection reset/.test(cause??'');
  let retry=false;
  if(io){if(n?.running){this.reconnected=true;retry=this.recovery.ioFailure(n.connectionId,this.ports.now(),cause==='SocketTimeout'?'SocketTimeout':'EOF');}else if(this.reconnected)retry=this.recovery.recoveryRoundFailed();}
  else{this.recovery.stop();this.reconnected=false;}
  const result=e instanceof Error?e:Error('LOCAL_IO');Object.assign(result,{b2Handled:true,stopAutomaticRecovery:!retry});if(!retry&&io)result.message='同步多次中断且没有进展，请稍后重试';return result;
 }

 async run(r:Row,connection:SyncFrameConnection,context:SyncActionContext){
  const n=this.sessions.get(context.session);if(!this.enabled()||!n?.account||n.business||!connection.detachStream)fail('AUTH_REVOKED');
  n.running=true;const account=n.account,watch=await this.ports.deviceId(),connectionId=n.connectionId;
  const gate=new SwitchGate(true,n.capability),reply=gate.accept(r,{identityVerified:true,accountConfirmed:true,legacyAcksDrained:true});
  const check=()=>{context.checkCancelled?.();if(!this.enabled())fail('AUTH_REVOKED');};
  const authorize=<T>(run:()=>Promise<T>)=>this.ports.account.withLibraryAccount(account,async()=>{check();return run();});
  await authorize(()=>connection.writeFrame(reply));gate.responseFullyWritten();
  const accountScope=D('wrss.library-resume.v1/account',[account.backendBaseUrl,account.userId]);
  const scope=D('wrss.library-binary.v2/storage',[accountScope,n.peer,watch]);
  let owner:LibraryBinaryConnection;const assets=new BinaryAssets(this.ports.files,this.ports.store,this.ports.chunks,check,()=>owner?.workUnit());
  await authorize(()=>this.ports.store.exclusive(async()=>{await this.ports.store.collect(scope,j=>this.ports.chunks.collect(D('wrss.library-binary.v2/native-scope',[scope,j.jobId]),false));await assets.collect();}));
  owner=new LibraryBinaryConnection({store:this.ports.store,chunks:this.ports.chunks,capability:n.capability,accountScope,phoneDeviceId:n.peer,watchDeviceId:watch,connectionId,authorize,check,sleep:this.ports.sleep,now:this.ports.now,sampleClock:this.ports.sampleClock,randomId:this.ports.randomId,recovery:this.recovery,
   freeze:()=>assets.freeze(scope,/* persistent snapshot identity */ connectionId,n.capability.limits),source:(w,s)=>assets.source(scope,w,s),publish:(l,o,d)=>assets.publish(l,o,d),apply:(_j,d,path,b)=>assets.apply(d,path,b),reserve:async(j,objects)=>{await assets.reserve(scope,j.jobId,j.description.selection.limits,objects);if(j.lease)for(const d of objects){check();await this.ports.chunks.status(j.lease as unknown as ObjectLease,{id:d.objectId,size:d.size,sha256:d.sha256,chunkHashes:d.chunkHashes});owner.workUnit();}},supportsRange:async()=>false,applied:this.ports.changed,
  },gate,new BinaryByteTransport(connection.detachStream() as SyncByteStream,this.ports.now));
  this.recovery.accountReady(connectionId,this.reconnected);const off=context.onCancel?.(()=>{void owner.cancel().catch(()=>{});});const accountOff=this.ports.account.subscribe(()=>{void this.ports.account.read().then(current=>{if(!current||current.userId!==account.userId||current.backendBaseUrl!==account.backendBaseUrl)void owner.close(new ResumeError('AUTH_REVOKED'));},()=>owner.close(new ResumeError('AUTH_REVOKED')));});
  try{await owner.run();this.recovery.detach(connectionId);this.reconnected=false;}
  catch(e){throw this.failed(e,context);}

  finally{off?.();accountOff();this.sessions.delete(context.session);}
 }
}
