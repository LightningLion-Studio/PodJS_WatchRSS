import type {CloudResultObserver} from './scheduler';
import type {CloudSyncResult} from './service';
import type {CloudHostRequest} from './host-ports';
let localTransferRevision=0;
export const MANUAL_INTENT_KEY='watchrss.cloud.manual.v1';
export type ManualMode='all'|'recent128';
export interface ManualIntent {version:1|2;token:string;scope:string;mode:ManualMode;createdAt:number;/** null only for a new grant before its first verified bootstrap. */epoch?:string|null}
export function readManualIntent(raw:unknown):ManualIntent|undefined{try{const v=typeof raw==='string'?JSON.parse(raw):raw;if((v?.version===1||v?.version===2)&&typeof v.token==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v.token)&&typeof v.scope==='string'&&v.scope.length>0&&v.scope.length<=2048&&['all','recent128'].includes(v.mode)&&Number.isFinite(v.createdAt)&&v.createdAt>=0&&(v.version===1||v.epoch===null||typeof v.epoch==='string'&&v.epoch.length>0&&v.epoch.length<=256))return v;}catch{}return;}
export function manualEpochKey(account:{userId:string;backendBaseUrl:string}){return 'watchrss.cloud.epoch.'+JSON.stringify([account.backendBaseUrl.replace(/\/+$/,''),account.userId]);}
export function manualScopeMatches(scope:string,userId:string,baseUrl:string){try{const s=JSON.parse(scope);return Array.isArray(s)&&s.length===2&&s[0]===userId&&typeof s[1]==='string'&&s[1].replace(/\/+$/,'')===baseUrl.replace(/\/+$/,'');}catch{return false;}}
export async function compareManualIntent(host:CloudHostRequest,expected:string|undefined,value:string|undefined){const r=await host<{updated:boolean}>('secure.compareAndSet',{key:MANUAL_INTENT_KEY,expected:expected??null,value:value??null});if(typeof r.updated!=='boolean')throw Error('cloud_manual_compare_unavailable');return r.updated;}
/** Bootstrap may fill an unbound epoch without replacing the grant. */
export function sameManualIntent(a:ManualIntent|undefined,b:ManualIntent){
 return a?.token===b.token&&a.scope===b.scope&&a.mode===b.mode&&a.createdAt===b.createdAt&&
  (a.epoch==null||b.epoch==null||a.epoch===b.epoch);
}
export async function completeManualIntent(host:CloudHostRequest,intent:ManualIntent){const stored=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY}),current=readManualIntent(stored.value);if(sameManualIntent(current,intent))return compareManualIntent(host,stored.value,undefined);return false;}
interface ManualRequestOptions {scope?:string; observe?:CloudResultObserver}
type ManualDispatch={dispatch(intent:ManualIntent,restored:boolean,observe:CloudResultObserver):Promise<boolean>};
/** A persisted intent is the authorization, not a new button press. Migration
 * keeps its exact token/mode/time; no random generation or scope promotion. */
export class CloudManualHandoff {
 private pending:ManualIntent|undefined;private foreground=true;private held=false;private serial=Promise.resolve();private revision=0;private disposed=false;
 private armed=new Set<string>();private running:{intent:ManualIntent;task:Promise<boolean>;result?:CloudSyncResult}|undefined;
 private phase:'idle'|'foreground'|'queued'|'held'|'waiting'='idle';private listeners=new Set<()=>void>();
 constructor(private readonly host:CloudHostRequest,private readonly scope:()=>Promise<string|undefined>,private readonly run:ManualDispatch|((mode:ManualMode,restored?:boolean,intent?:ManualIntent)=>Promise<boolean>),private readonly now=Date.now,private readonly epoch:()=>Promise<string|undefined>=async()=>undefined){}
 get state(){return {phase:this.phase,mode:this.pending?.mode,createdAt:this.pending?.createdAt};}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private publish(phase:typeof this.phase){this.phase=phase;for(const fn of this.listeners)try{fn();}catch{}}
 private write<T>(operation:()=>Promise<T>):Promise<T>{const result=this.serial.then(operation,operation);this.serial=result.then(()=>{},()=>{});return result;}
 private async arm(intent:ManualIntent){
  if(this.pending!==intent||this.disposed)return false;
  const foreground=this.foreground,key=intent.token+':'+foreground;
  if(this.armed.has(key)){if(!foreground)this.publish(this.held?'held':'queued');return true;}
  try{await this.host('cloud.enqueue',{token:intent.token,standby:foreground});}
  catch{if(this.pending===intent)this.publish(this.held?'held':'waiting');return false;}
  if(this.pending!==intent||this.disposed)return false;
  this.armed.add(key);
  if(foreground===this.foreground)this.publish(this.held?'held':foreground?'foreground':'queued');
  return true;
 }
 async authorized(expectedScope?:string):Promise<ManualIntent|undefined>{return this.write(async()=>{
  const revision=this.revision;if(this.disposed)return;
  const stored=await this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});
  if(this.disposed||revision!==this.revision)return;
  let intent=readManualIntent(stored.value);
  if(!intent){this.pending=undefined;this.publish('idle');return;}
  const scope=await this.scope(),epoch=await this.epoch();if(this.disposed||revision!==this.revision)return;
  if(expectedScope!==undefined&&(scope!==expectedScope||intent.scope!==expectedScope))return;
  if(!scope||scope!==intent.scope||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch||intent.version===1&&!epoch){
   await compareManualIntent(this.host,stored.value,undefined);if(this.disposed||revision!==this.revision)return;this.pending=undefined;this.armed.clear();this.publish('idle');return;
  }
  if(intent.version===1||intent.epoch===null&&epoch){intent={...intent,version:2,epoch:epoch??null};if(!await compareManualIntent(this.host,stored.value,JSON.stringify(intent)))return;}
  if(this.disposed||revision!==this.revision)return;
  const pending=this.pending;if(pending&&sameManualIntent(pending,intent)&&pending.epoch===intent.epoch)intent=pending;
  this.pending=intent;return intent;
 });}
 async restore(resume=true,options:ManualRequestOptions={}){
  const intent=await this.authorized(options.scope);
  if(!intent||!await this.arm(intent)||!resume||!this.foreground||this.held)return false;
  return this.continue(intent,true,options.observe);
 }
 private async continue(intent:ManualIntent,restored:boolean,observe?:CloudResultObserver):Promise<boolean>{
  if(this.disposed||!this.foreground||this.held||this.pending!==intent)return false;
  const revision=this.revision;
  let run=this.running;
  if(!run||!sameManualIntent(run.intent,intent)){
   this.publish('foreground');
   const execution:{intent:ManualIntent;task:Promise<boolean>;result?:CloudSyncResult}={
    intent,
    task:this.execute(intent,restored,result=>{execution.result=result;}).finally(()=>{
     if(this.running===execution)this.running=undefined;
    }),
   };
   this.running=run=execution;
  }
  const success=await run.task;
  if(this.disposed||revision!==this.revision)return false;
  if(run.result)observe?.(run.result);
  return success;
 }
 private async execute(intent:ManualIntent,restored:boolean,observe:CloudResultObserver){
  const revision=this.revision,current=await this.authorized(intent.scope);
  if(!current||!sameManualIntent(current,intent)||revision!==this.revision||!this.foreground||this.held)return false;
  const success=typeof this.run==='function'
   ? await this.run(current.mode,restored,current)
   : await this.run.dispatch(current,restored,observe);
  if(success&&typeof this.run==='function')await this.completeExecuted(current);
  if(!success&&this.pending===current){this.publish(this.held?'held':'waiting');await this.arm(current);}
  return success;
 }
 async manual(mode:ManualMode='recent128',options:ManualRequestOptions={}){
  const revision=++this.revision,scope=await this.scope(),epoch=await this.epoch();if(!scope||options.scope!==undefined&&scope!==options.scope||revision!==this.revision||this.disposed)return false;
  const random=await this.host<{bytesBase64:string}>('crypto.random',{bytes:18});if(revision!==this.revision||this.disposed)return false;
  const intent:ManualIntent={version:2,token:random.bytesBase64.replace(/[^a-zA-Z0-9_-]/g,'_'),scope,mode,createdAt:this.now(),epoch:epoch??null};
  const saved=await this.write(async()=>{
   const currentScope=await this.scope(),currentEpoch=await this.epoch();
   if(revision!==this.revision||this.disposed||scope!==currentScope||epoch!==currentEpoch)return false;
   const old=await this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});
   if(revision!==this.revision||this.disposed||!await compareManualIntent(this.host,old.value,JSON.stringify(intent)))return false;
   if(revision!==this.revision||this.disposed)return false;
   this.pending=intent;this.armed.clear();return true;
  });
  // Arm durable standby before running. A failed registration leaves the grant available for restore.
  if(!saved||!await this.arm(intent))return false;
  return this.continue(intent,false,options.observe);
 }
 async progress(intent:ManualIntent){const current=await this.authorized(intent.scope);if(!current||current.token!==intent.token||current.scope!==intent.scope||current.mode!==intent.mode||current.epoch!==intent.epoch)return false;try{await this.host('cloud.enqueue',{token:intent.token,progress:true});return true;}catch{this.publish('waiting');return false;}}
 captureCompletion(){const intent=this.pending;return(success:boolean)=>success&&intent?this.completeExecuted(intent):Promise.resolve();}
 async completeExecuted(intent:ManualIntent){
  await this.write(async()=>{
   if(!sameManualIntent(this.pending,intent))return;
   try{await completeManualIntent(this.host,intent);}
   finally{if(sameManualIntent(this.pending,intent)){this.pending=undefined;this.armed.clear();this.publish('idle');}}
  });
 }
 foregroundChanged(active:boolean){const changed=this.foreground!==active;this.foreground=active;if(this.disposed)return;if(active&&changed)void this.restore().catch(()=>this.publish('waiting'));else if(!active&&this.pending){this.publish(this.held?'held':'waiting');void this.arm(this.pending);}}
 localTransferChanged(active:boolean){this.held=active;void this.host('cloud.localTransfer',{active,generation:++localTransferRevision}).catch(()=>{});if(this.pending){this.publish(active?'held':'waiting');if(!active){if(this.foreground)void this.restore().catch(()=>this.publish('waiting'));else void this.arm(this.pending);}}}
 accountChanged(){this.revision++;this.running=undefined;this.pending=undefined;this.armed.clear();this.publish('idle');}
 dispose(){this.disposed=true;this.accountChanged();this.listeners.clear();}
}
