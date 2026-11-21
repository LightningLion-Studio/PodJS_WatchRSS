import type {SqlCancellationCheck} from '../../core/types';
import type {LocalBodyClaim} from '../../sync-v2/local-body-claims';
import {bookDescription} from './book-plan';
import type {NoteAssetFileIndex} from '../../notes/asset-files';
import config from '../../../pod.config.json';
import {noteAssetIntake} from '../../sync-v2/local-transfer-intake';
import type {WatchAccountStore} from '../../account/store';
import type {WatchAccountState} from '../../account/types';
import type {SyncActionContext,SyncFrameConnection} from '../session';
import type {VerifiedChunkStore,ObjectLease} from '@podjs/framework/verified-chunk-store';
import {BinaryStore} from './store';
import {BinaryAssets,STAGING_COPIES,type BinaryAssetFiles} from './assets';
import {ARTICLE_IMPORT_SHADOW_BYTES,BinaryLibraryKinds} from './kinds';
import {BinaryBooks} from './books';
import type {BinaryBookFiles} from './book-import';
import type {BinaryArticleFiles} from './article-file';
import {BinaryByteTransport,type FileStream,type NativeFramePort} from './transport';
import {LibraryBinaryConnection} from './coordinator';
import {SwitchGate,binaryCapability,negotiate,RELEASE_B2_ENABLED} from './routing';
import {RecoveryRules} from './recovery';
import {D} from './digests';
import {supportsGuardedLibrary} from '../wire-json';
import type {SqlLibrarySessionRepository} from '../library-repository';
import {BOOK_KINDS,HARD_LIMITS,ResumeError,fail,text,type Row,type Capability} from './wire';
export interface BinarySessionPort {
 probe(request:Row,context:SyncActionContext):Promise<Row>;
 accountConfirmed(request:Row,context:SyncActionContext):Promise<void>;
 run(request:Row,connection:SyncFrameConnection,context:SyncActionContext):Promise<void>;
 failed?(error:unknown,context?:SyncActionContext):unknown;
 business?(context:SyncActionContext):void;
 acceptsLegacySubset?(peer:string,context:SyncActionContext):boolean;
}
interface Negotiation {peer:string;capability:Capability;account?:WatchAccountState;connectionId:string;running:boolean;books:boolean;guarded:boolean;accountEpoch?:number}
export interface BinaryApplicationPorts {
 /** Presence requires a guarded proposal for every B2 connection. */
 guardedRuntime?:()=>Promise<boolean>;
 assetIndex?:NoteAssetFileIndex;
 receiveClaims?(scope:string,connection:string,claims:LocalBodyClaim[]):Promise<()=>Promise<void>>;
 sessionTransaction?:(context:SyncActionContext,statements:Parameters<BinaryStore['db']['transaction']>[0])=>Promise<number[]>;
 b2Enabled?:boolean;byteBridge():boolean;localPermission():boolean;store:BinaryStore;chunks:VerifiedChunkStore;files:BinaryAssetFiles;
 library?:{repository():Promise<SqlLibrarySessionRepository>;files:BinaryArticleFiles};
 books?:BinaryBookFiles;
 bookWork?(advance:()=>void):{files:BinaryBookFiles;stop():void};
 /** Enabled after the native book pipeline meets its release acceptance gates. */
 b2BooksEnabled?:boolean;
 bookRuntime?():Promise<boolean>;
 bookExcluded?(kind:'bookState'|'bookReading',limit:'body'|'string'):void;
 intake?:import('../../sync-v2/local-transfer-intake').LocalTransferIntake;
 account:WatchAccountStore;deviceId():Promise<string>;randomId():Promise<string>;now():number;
 sampleClock?():Promise<void>;
 guardedTransaction?:import('./coordinator').BinaryPorts['guardedTransaction'];
 durableTransaction?:import('./coordinator').BinaryPorts['durableTransaction'];
 sleep(milliseconds:number):{result:Promise<void>;cancel():void};changed?(kind?:string):void;
 /** Native listener identity is fixed per accepted stream. */
 recovery?:RecoveryRules;
}
/** RFCOMM only. There is no capability, table creation or file I/O when off. */
export class BinaryApplicationService implements BinarySessionPort {
 private readonly sessions=new WeakMap<object,Negotiation>();
 // The action context belongs to one physical session. A probe only replaces
 // negotiation state, so it cannot reopen a connection already used for v1.
 private readonly v1Sessions=new WeakSet<SyncActionContext>();
 private recovery:RecoveryRules;
 private reconnected=false;
 constructor(private readonly ports:BinaryApplicationPorts){this.recovery=ports.recovery??new RecoveryRules();}
 private enabled(){return (this.ports.b2Enabled??RELEASE_B2_ENABLED)&&this.ports.byteBridge()&&this.ports.localPermission();}
 canSwitch(){return this.enabled();}
 async probe(r:Row,context:SyncActionContext):Promise<Row>{
  this.sessions.delete(context.session);if(!this.enabled())return {};
  const guarded=this.ports.guardedRuntime!==undefined;
  if(guarded&&(!supportsGuardedLibrary(r)||this.v1Sessions.has(context)))return {};
  if(r.supportedLibraryBinaryVersions===undefined)return {};
  const versions=r.supportedLibraryBinaryVersions;if(!Array.isArray(versions)||versions.some(v=>!Number.isSafeInteger(v)||v<1)||new Set(versions).size!==versions.length)fail('CAPABILITY_MISMATCH');if(!versions.includes(2))return {};
  if(this.ports.guardedRuntime&&!await this.ports.guardedRuntime())return {};
  const peer=text(r.deviceId,128),runtime=await this.ports.chunks.runtime();if(!runtime?.chunkReceipt||!runtime.requestBindings)fail('CAPABILITY_MISMATCH');
  await this.ports.sampleClock?.();await this.ports.store.initialize();await this.ports.store.observeClock(runtime.elapsedMillis);
  const kinds:Capability['kinds']=[{kind:'noteAsset',schemaVersion:1,send:true,receive:true}];
  if(this.ports.library){
   kinds.unshift({kind:'articleBody',schemaVersion:1,send:false,receive:true},{kind:'articleMetadata',schemaVersion:1,send:false,receive:true});
   kinds.push({kind:'rssSource',schemaVersion:1,send:true,receive:true});
  }
  const books=!!(this.ports.b2BooksEnabled&&runtime.fileRefs&&(this.ports.books||this.ports.bookWork)&&this.ports.library&&
   (await this.ports.bookRuntime?.()??true)&&
   await (await this.ports.library.repository()).books?.binaryReady());
  if(books){
   for(const kind of BOOK_KINDS)kinds.push({kind,schemaVersion:1,send:true,receive:true});
   kinds.sort((a,b)=>a.kind<b.kind?-1:1);
  }
  const importBudget=this.ports.library?ARTICLE_IMPORT_SHADOW_BYTES:0;
  const maxStagingBytes=books?HARD_LIMITS.maxStagingBytes:Math.min(134217728,runtime.maxStagingBytes+importBudget);
  const maxObjectBytes=Math.min(this.ports.library?HARD_LIMITS.maxObjectBytes:5242880,runtime.maxObjectBytes,Math.floor((maxStagingBytes-importBudget)/STAGING_COPIES));
  if(maxObjectBytes<1)fail('CAPABILITY_MISMATCH');
  const cap=binaryCapability(kinds,{...HARD_LIMITS,maxObjectBytes,maxPlanObjects:512,maxManifestBytes:books?786432:262144,maxMetadataBytes:this.ports.library?HARD_LIMITS.maxMetadataBytes:1024,maxJournalBytes:books?HARD_LIMITS.maxJournalBytes:33554432,maxInFlightObjects:books?1:Math.min(4,runtime.maxInFlightObjects),maxStagingBytes});
  const connectionId=await this.ports.randomId();
  context.checkCancelled?.();
  if(!this.enabled())return {};
  if(this.recovery.snapshot.stopped&&!this.reconnected)this.recovery=new RecoveryRules();
  this.sessions.set(context.session,{peer,capability:cap,connectionId,running:false,books,guarded});
  return {libraryPeer:{implementation:'podjs',appVersion:config.versionName},libraryBinary:cap,...(guarded?{guardedLibraryVersion:1}:{})};
 }
 business(context:SyncActionContext){this.v1Sessions.add(context);}
 acceptsLegacySubset(peer:string,context:SyncActionContext){
  if(!this.enabled()||!this.ports.library)return false;
  const n=this.sessions.get(context.session);
  if(n?.peer!==peer||!n.account||n.running)fail('AUTH_REVOKED');
  return true;
 }
 async accountConfirmed(r:Row,context:SyncActionContext){
  const n=this.sessions.get(context.session);if(!n)return;
  const epoch=this.ports.account.librarySessionGeneration(),account=await this.ports.account.read();
  context.checkCancelled?.();
  if(!account||!r.account||(r.account as Row).userId!==account.userId||r.deviceId!==undefined&&r.deviceId!==n.peer)fail('ACCOUNT_MISMATCH');
  if(n.guarded&&(this.sessions.get(context.session)!==n||epoch!==this.ports.account.librarySessionGeneration()))fail('AUTH_REVOKED');
  n.account=account;n.accountEpoch=epoch;this.recovery.accountReady(n.connectionId,this.reconnected);
 }
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
  const n=this.sessions.get(context.session);if(!this.enabled()||!n?.account||n.running||this.v1Sessions.has(context)||!connection.detachStream)fail('AUTH_REVOKED');
  n.running=true;const account=n.account,watch=await this.ports.deviceId(),connectionId=n.connectionId;
  const gate=new SwitchGate(true,n.capability),reply=gate.accept(r,{identityVerified:true,accountConfirmed:true,legacyAcksDrained:true});
  const check=()=>{context.checkCancelled?.();if(!this.enabled()||n.guarded&&(this.sessions.get(context.session)!==n||n.accountEpoch!==this.ports.account.librarySessionGeneration()))fail('AUTH_REVOKED');};
  const authorize=<T>(run:()=>Promise<T>)=>this.ports.account.withLibraryAccount(account,async()=>{check();return run();});
  const intake=this.ports.intake,sessionTransaction=this.ports.sessionTransaction;
  if(n.guarded&&(!intake||!sessionTransaction||!this.ports.guardedTransaction||!this.ports.assetIndex))fail('CAPABILITY_MISMATCH');
  const stamp=async()=>await intake!(account,watch,async protect=>{
   if(!protect.guardedStamp)fail('BUSINESS_REJECTED');
   return protect.guardedStamp();
  });
  const initial=n.guarded?await authorize(stamp):undefined;
  await authorize(()=>connection.writeFrame(reply));gate.responseFullyWritten();
  const accountScope=D('wrss.library-resume.v1/account',[account.backendBaseUrl,account.userId]);
  const scope=D('wrss.library-binary.v2/storage',[accountScope,n.peer,watch]);
  let owner:LibraryBinaryConnection;
  const work:SqlCancellationCheck=Object.assign(()=>{check();owner?.commitCheck();owner?.workUnit();},{
   onCancel:(cancel:()=>void)=>owner?.commitCheck.onCancel?.(cancel)??context.onCancel?.(cancel)??(()=>{}),
  });
  const write:import('../../sync-v2/local-transfer-intake').BoundLocalTransferIntake|undefined=intake?apply=>intake(account,watch,apply):undefined;
  const protectAsset=write?noteAssetIntake(write,2,n.peer,work):undefined;
  const kinds=this.ports.library?new BinaryLibraryKinds(this.ports.library.repository,this.ports.library.files,work,write):undefined;
  const fileWork=this.ports.bookWork?.(work),bookFiles=fileWork?.files??this.ports.books;
  const books=bookFiles&&this.ports.library?new BinaryBooks(this.ports.store,async()=>(await this.ports.library!.repository()).books,bookFiles,this.ports.chunks,work,this.ports.bookExcluded,write,async state=>(await this.ports.library!.repository()).cloudBookWitness(state.bookId,state)):undefined;
  const assets=new BinaryAssets(this.ports.files,this.ports.store,this.ports.chunks,check,work,kinds,n.books?books:undefined,n.guarded?this.ports.assetIndex:undefined);
  await authorize(()=>this.ports.store.exclusive(async()=>{
   await this.ports.store.collect(scope,async job=>{
    await this.ports.chunks.collect(D('wrss.library-binary.v2/native-scope',[scope,job.jobId]),false);
    await books?.collect(job);
   });
   await assets.collect();
  }));
  const stream=connection.detachStream() as FileStream;
  let native:NativeFramePort|undefined;
  if((n.books||n.guarded)&&stream.claimBinary)try{await authorize(async()=>{
   await stream.claimBinary!();
   native=await stream.openFramed?.();
  });}
  catch(error){await stream.close();throw error;}
  let releaseClaims:(()=>Promise<void>)|undefined;
  owner=new LibraryBinaryConnection({store:this.ports.store,chunks:this.ports.chunks,capability:n.capability,accountScope,phoneDeviceId:n.peer,watchDeviceId:watch,connectionId,authorize,check,sleep:this.ports.sleep,now:this.ports.now,sampleClock:this.ports.sampleClock,randomId:this.ports.randomId,recovery:this.recovery,
   protectNoteAsset:protectAsset?(job,object,stage,apply)=>{
    let file:ReturnType<typeof stage>|undefined;
    const body={size:object.size,sha256:object.sha256,read:async(offset:number,length:number)=>{
     work();const {path}=await (file??=stage());
     return (await this.ports.files.readBytes(path,offset,length)).bytes;
    }};
    return protectAsset({cursor:job.jobId+':'+object.objectId,logicalId:object.businessId,body},apply);
   }:undefined,
   ...(initial?{guarded:{accountAnchor:initial.anchor,stamp,transaction:statements=>sessionTransaction!({...context,checkCancelled:owner.commitCheck,onCancel:owner.commitCheck.onCancel},statements)}}:{}),
   ...(initial?{verifyReceipt:(job,d,outcome,objects)=>assets.verifyReceipt(job,d,outcome,objects)}:{}),
   stopLocalWork:fileWork?.stop,guardedTransaction:this.ports.guardedTransaction,durableTransaction:this.ports.durableTransaction,
   freeze:peer=>{const selection=negotiate(n.capability,peer);return assets.freeze(scope,connectionId,selection?.limits??n.capability.limits,new Set(selection?.kinds.map(k=>k.kind)));},source:(w,s)=>assets.source(scope,w,s),publish:(l,o,d,j)=>assets.publish(l,o,d,j),apply:(j,d,path,b)=>assets.apply(d,path,b,n.peer,j),cleanupCompleted:j=>books?.collect(j)??Promise.resolve(),reserve:async(j,objects)=>{if(j.state==='PLANNING')kinds?.validatePlan(objects);await assets.reserve(scope,j.jobId,j.description.selection.limits,objects);
    if(initial&&this.ports.receiveClaims&&!releaseClaims){
     const claims:LocalBodyClaim[]=[];
     for(const object of objects){
      if(object.kind==='noteAsset')claims.push({kind:'asset',logicalId:object.businessId,sha256:object.sha256});
      if(object.kind==='bookPackageCommit'){
       const book=bookDescription(object,j.description.selection.limits);
       if(book.kind==='bookPackageCommit')claims.push({kind:'book',logicalId:book.metadata.bookId,sha256:book.metadata.packageSha256});
      }
     }
     if(claims.length)releaseClaims=await this.ports.receiveClaims(initial.scope,connectionId,claims);
    }
    if(j.lease&&!j.description.selection.kinds.some(k=>k.kind.startsWith('book')))for(const d of objects){check();await this.ports.chunks.status(j.lease as unknown as ObjectLease,{id:d.objectId,size:d.size,sha256:d.sha256,chunkHashes:d.chunkHashes});owner.workUnit();}},supportsRange:async()=>false,applied:this.ports.changed,
  },gate,new BinaryByteTransport(stream,this.ports.now,undefined,native));
  this.recovery.accountReady(connectionId,this.reconnected);const off=context.onCancel?.(()=>{void owner.cancel().catch(()=>{});});const accountOff=this.ports.account.subscribe(()=>{void this.ports.account.read().then(current=>{if(!current||current.userId!==account.userId||current.backendBaseUrl!==account.backendBaseUrl)void owner.close(new ResumeError('AUTH_REVOKED'));},()=>owner.close(new ResumeError('AUTH_REVOKED')));});
  try{await owner.run();this.recovery.detach(connectionId);this.reconnected=false;}
  catch(e){throw this.failed(e,context);}

  finally{off?.();accountOff();this.sessions.delete(context.session);await releaseClaims?.();}
 }
}
