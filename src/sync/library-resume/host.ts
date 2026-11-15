import type {WatchAccountStore} from '../../account/store';
import type {WatchAccountState} from '../../account/types';
import type {SqlLibrarySessionRepository} from '../library-repository';
import type {SyncActionContext,SyncFrameConnection} from '../session';
import {VerifiedChunkStore} from '@podjs/framework/verified-chunk-store';
import {LibraryResumeConnection} from './coordinator';
import {ResumeStore} from './store';
import {ResumeAssets,type AssetHost} from './assets';
import {D} from './digests';
import {applyResumeObject,sourcePlan,resumeInventoryDigest} from './repository';
import {HARD_LIMITS,capability,text,fail,envelope,ResumeError,resumeError,type Capability,type Row} from './wire';

export interface ResumeSessionPort {
 probe(request:Row,context:SyncActionContext):Promise<Row>;
 accountConfirmed(request:Row,context:SyncActionContext):Promise<void>;
 run(request:Row,connection:SyncFrameConnection,context:SyncActionContext):Promise<void>;
}
interface Negotiation {peer:string;capability:Capability;account?:WatchAccountState}
/** Only production-supported transaction ports are advertised. Reader remains
 * v14 until its KV authority and every local editor migrate to this same DB.
 */
export class ResumeApplicationService implements ResumeSessionPort {
 private readonly sessions=new WeakMap<object,Negotiation>();
 constructor(private readonly ports:{store:ResumeStore;chunks:VerifiedChunkStore;account:WatchAccountStore;repository:()=>Promise<SqlLibrarySessionRepository>;randomId:()=>Promise<string>;localPermission:()=>boolean;assetHost?:AssetHost;readFile:(path:string,size:number)=>Promise<Uint8Array>;changed?:()=>void;diagnostic?:(error:unknown)=>void}){}
 async probe(request:Row,context:SyncActionContext):Promise<Row>{
  this.sessions.delete(context.session);
  if(!Array.isArray(request.supportedLibraryResumeVersions)||!request.supportedLibraryResumeVersions.includes(1)||!this.ports.localPermission())return {};
  let peer:string;try{peer=text(request.deviceId,128);}catch{return {};}
  const runtime=await this.ports.chunks.runtime();if(!runtime)return {};
  try{await this.ports.store.initialize();await this.ports.store.observeClock(runtime.elapsedMillis);await this.ports.repository();}catch{return {};}
  const offered:Capability={version:1,kinds:[{kind:'articleBody',schemaVersion:1,send:true,receive:true},{kind:'articleMetadata',schemaVersion:1,send:true,receive:true},...(this.ports.assetHost?[{kind:'noteAsset' as const,schemaVersion:1 as const,send:true,receive:true}]:[]),{kind:'rssSource',schemaVersion:1,send:true,receive:true}],limits:{...HARD_LIMITS,maxObjectBytes:Math.min(HARD_LIMITS.maxObjectBytes,runtime.maxObjectBytes),maxInFlightObjects:Math.min(4,runtime.maxInFlightObjects),maxStagingBytes:Math.min(HARD_LIMITS.maxStagingBytes,runtime.maxStagingBytes)}};
  capability(offered);this.sessions.set(context.session,{peer,capability:offered});return {libraryResume:offered};
 }
 async accountConfirmed(request:Row,context:SyncActionContext):Promise<void>{
  const n=this.sessions.get(context.session);if(!n)return;
  const current=await this.ports.account.read(),supplied=request.account as Row|undefined;
  if(!current||!supplied||supplied.userId!==current.userId||request.deviceId!==undefined&&request.deviceId!==n.peer)fail('ACCOUNT_MISMATCH');
  n.account=current;
 }
 async run(first:Row,connection:SyncFrameConnection,context:SyncActionContext):Promise<void>{
  const n=this.sessions.get(context.session);if(!n?.account||!this.ports.localPermission()){
   const code=!this.ports.localPermission()?'AUTH_REVOKED':'ACCOUNT_REQUIRED',r=envelope(first),{payload,...base}=r;
   await connection.writeFrame({...base,type:'response',success:false,result:null,error:new ResumeError(code).wire()} as unknown as Row);fail(code);
  }
  const assets=this.ports.assetHost?new ResumeAssets(this.ports.assetHost,this.ports.store,this.ports.chunks):undefined;
  const account=n.account,repository=await this.ports.repository(),watch=await repository.deviceId(),connectionId=await this.ports.randomId();
  const accountScope=D('wrss.library-resume.v1/account',[account.backendBaseUrl,account.userId]),scope=D('wrss.library-resume.v1/storage',[accountScope,n.peer,watch]);
  const check=()=>{context.checkCancelled?.();if(!this.ports.localPermission())fail('AUTH_REVOKED');};
  const current=<T>(run:()=>Promise<T>)=>this.ports.account.withLibraryAccount(account,async()=>{check();const runtime=await this.ports.chunks.runtime();if(!runtime)fail('CAPABILITY_MISMATCH');await this.ports.store.observeClock(runtime.elapsedMillis);try{return await run();}catch(e){this.ports.diagnostic?.(e);throw resumeError(e);}});
  await current(()=>this.ports.store.exclusive(()=>this.ports.store.collect(scope,job=>this.ports.chunks.collect(D('wrss.library-resume.v1/native-scope',[scope,job.jobId]),true))));
  const owner=new LibraryResumeConnection({store:this.ports.store,chunks:this.ports.chunks,capability:n.capability,accountScope,phoneDeviceId:n.peer,watchDeviceId:watch,connectionId,authorize:current,check,randomId:this.ports.randomId,
   freeze:async()=>{check();const inventory=await repository.resumeFreeze(check);if(assets)inventory.assets=await assets.freeze();return {witness:{snapshotId:await this.ports.randomId(),manifestDigest:resumeInventoryDigest(inventory),fromExclusive:0,toInclusive:0},inventory};},
   source:(w,s)=>sourcePlan(repository,this.ports.store,scope,w,s,assets?.read.bind(assets)),
   publish:(lease,object,d)=>d.kind==='noteAsset'&&assets?assets.publish(lease,object,d):this.ports.chunks.finalize(lease,object),
   apply:(job,object,path,boundary)=>object.kind==='noteAsset'&&assets?assets.apply(object,path,boundary):applyResumeObject(repository,{read:this.ports.readFile},job,object,path,boundary),
   // This first product port freezes subplans (0/0). A kind list alone
   // cannot attest that every operation in a global sequence range is covered.
   supportsRange:async()=>false,
   applied:this.ports.changed,diagnostic:this.ports.diagnostic,
  },connection);
  const stop=context.onCancel?.(()=>{void owner.close();});try{await owner.run(first);}finally{stop?.();this.sessions.delete(context.session);}
 }
}
