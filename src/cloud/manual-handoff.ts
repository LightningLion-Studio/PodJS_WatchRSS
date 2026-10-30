import type {CloudHostRequest} from './host-ports';
let localTransferRevision=0;
export const MANUAL_INTENT_KEY='watchrss.cloud.manual.v1';
export type ManualMode='all'|'recent128';
export interface ManualIntent {version:1|2;token:string;scope:string;mode:ManualMode;createdAt:number;/** null only for a new grant before its first verified bootstrap. */epoch?:string|null}
export function readManualIntent(raw:unknown):ManualIntent|undefined{try{const v=typeof raw==='string'?JSON.parse(raw):raw;if((v?.version===1||v?.version===2)&&typeof v.token==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v.token)&&typeof v.scope==='string'&&v.scope.length>0&&v.scope.length<=2048&&['all','recent128'].includes(v.mode)&&Number.isFinite(v.createdAt)&&v.createdAt>=0&&(v.version===1||v.epoch===null||typeof v.epoch==='string'&&v.epoch.length>0&&v.epoch.length<=256))return v;}catch{}return;}
export function manualEpochKey(account:{userId:string;backendBaseUrl:string}){return 'watchrss.cloud.epoch.'+JSON.stringify([account.backendBaseUrl.replace(/\/+$/,''),account.userId]);}
export function manualScopeMatches(scope:string,userId:string,baseUrl:string){try{const s=JSON.parse(scope);return Array.isArray(s)&&s.length===2&&s[0]===userId&&typeof s[1]==='string'&&s[1].replace(/\/+$/,'')===baseUrl.replace(/\/+$/,'');}catch{return false;}}
export async function compareManualIntent(host:CloudHostRequest,expected:string|undefined,value:string|undefined){const r=await host<{updated:boolean}>('secure.compareAndSet',{key:MANUAL_INTENT_KEY,expected:expected??null,value:value??null});if(typeof r.updated!=='boolean')throw Error('cloud_manual_compare_unavailable');return r.updated;}
export async function completeManualIntent(host:CloudHostRequest,intent:ManualIntent){const stored=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY}),current=readManualIntent(stored.value);if(current?.token===intent.token&&current.scope===intent.scope)return compareManualIntent(host,stored.value,undefined);return false;}
/** A persisted intent is the authorization, not a new button press. Migration
 * keeps its exact token/mode/time; no random generation or scope promotion. */
export class CloudManualHandoff {
 private pending:ManualIntent|undefined;private foreground=true;private held=false;private serial=Promise.resolve();private revision=0;private disposed=false;
 private armed=new Set<string>();private running:Promise<boolean>|undefined;private runningIntent:ManualIntent|undefined;
 private phase:'idle'|'foreground'|'queued'|'held'|'waiting'='idle';private listeners=new Set<()=>void>();
 constructor(private readonly host:CloudHostRequest,private readonly scope:()=>Promise<string|undefined>,private readonly run:(mode:ManualMode)=>Promise<boolean>,private readonly now=Date.now,private readonly epoch:()=>Promise<string|undefined>=async()=>undefined){}
 get state(){return {phase:this.phase,mode:this.pending?.mode,createdAt:this.pending?.createdAt};}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private publish(phase:typeof this.phase){this.phase=phase;for(const fn of this.listeners)try{fn();}catch{}}
 private write<T>(operation:()=>Promise<T>):Promise<T>{const result=this.serial.then(operation,operation);this.serial=result.then(()=>{},()=>{});return result;}
 private async arm(intent:ManualIntent){if(this.pending!==intent||this.disposed)return;const key=intent.token+':'+this.foreground;if(this.armed.has(key)){if(!this.foreground)this.publish(this.held?'held':'queued');return;}try{await this.host('cloud.enqueue',{token:intent.token,standby:this.foreground});this.armed.add(key);if(this.pending===intent)this.publish(this.held?'held':this.foreground?'foreground':'queued');}catch{if(this.pending===intent)this.publish(this.held?'held':'waiting');}}
 async authorized():Promise<ManualIntent|undefined>{return this.write(async()=>{
  const revision=this.revision;if(this.disposed)return;
  const stored=await this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});let intent=readManualIntent(stored.value);
  if(!intent){this.pending=undefined;this.publish('idle');return;}
  const scope=await this.scope(),epoch=await this.epoch();if(this.disposed||revision!==this.revision)return;
  if(!scope||scope!==intent.scope||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch||intent.version===1&&!epoch){
   await compareManualIntent(this.host,stored.value,undefined);this.pending=undefined;this.armed.clear();this.publish('idle');return;
  }
  if(intent.version===1||intent.epoch===null&&epoch){intent={...intent,version:2,epoch:epoch??null};if(!await compareManualIntent(this.host,stored.value,JSON.stringify(intent)))return;}
  if(this.pending?.token===intent.token&&this.pending.epoch===intent.epoch)intent=this.pending;
  this.pending=intent;return intent;
 });}
 async restore(resume=true){const intent=await this.authorized();if(!intent)return false;await this.arm(intent);if(resume&&this.foreground&&!this.held)return this.continue(intent);return false;}
 private continue(intent:ManualIntent):Promise<boolean>{
  if(this.running)return this.runningIntent===intent?this.running:this.running.catch(()=>false).then(()=>this.continue(intent));if(this.disposed||!this.foreground||this.held||this.pending!==intent)return Promise.resolve(false);
  this.publish('foreground');this.runningIntent=intent;let task!:Promise<boolean>;task=(async()=>{try{const current=await this.authorized();if(current?.token!==intent.token||current.scope!==intent.scope||current.mode!==intent.mode||!this.foreground||this.held)return false;const success=await this.run(intent.mode);if(success)await this.complete(intent,true);else if(this.pending===intent){this.publish(this.held?'held':'waiting');await this.arm(intent);}return success;}finally{if(this.running===task){this.running=undefined;this.runningIntent=undefined;}}})();this.running=task;return task;
 }
 async manual(mode:ManualMode='recent128'){
  const revision=++this.revision,scope=await this.scope(),epoch=await this.epoch();if(!scope||revision!==this.revision||this.disposed)return false;
  const random=await this.host<{bytesBase64:string}>('crypto.random',{bytes:18});if(revision!==this.revision||this.disposed)return false;
  const intent:ManualIntent={version:2,token:random.bytesBase64.replace(/[^a-zA-Z0-9_-]/g,'_'),scope,mode,createdAt:this.now(),epoch:epoch??null};
  const saved=await this.write(async()=>{if(revision!==this.revision||this.disposed||scope!==await this.scope()||epoch!==await this.epoch())return false;const old=await this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});if(!await compareManualIntent(this.host,old.value,JSON.stringify(intent)))return false;this.pending=intent;this.armed.clear();return true;});
  if(!saved||this.pending!==intent)return false;
  // Arm durable OS work before awaiting a foreground run. A lost HOME callback
  // or a killed guest can no longer erase the continuation opportunity.
  await this.arm(intent);return this.continue(intent);
 }
 async progress(intent:ManualIntent){const current=await this.authorized();if(!current||current.token!==intent.token||current.scope!==intent.scope||current.mode!==intent.mode||current.epoch!==intent.epoch)return false;try{await this.host('cloud.enqueue',{token:intent.token,progress:true});return true;}catch{this.publish('waiting');return false;}}
 captureCompletion(){const intent=this.pending;return(success:boolean)=>intent?this.complete(intent,success):Promise.resolve();}
 private async complete(intent:ManualIntent,success:boolean){if(!success)return;await this.write(async()=>{if(this.pending?.token!==intent.token||this.pending.scope!==intent.scope)return;await completeManualIntent(this.host,intent);if(this.pending?.token===intent.token&&this.pending.scope===intent.scope){this.pending=undefined;this.armed.clear();this.publish('idle');}});}
 foregroundChanged(active:boolean){const changed=this.foreground!==active;this.foreground=active;if(this.disposed)return;if(active&&changed)void this.restore().catch(()=>this.publish('waiting'));else if(!active&&this.pending){this.publish(this.held?'held':'waiting');void this.arm(this.pending);}}
 localTransferChanged(active:boolean){this.held=active;void this.host('cloud.localTransfer',{active,generation:++localTransferRevision}).catch(()=>{});if(this.pending){this.publish(active?'held':'waiting');if(!active){if(this.foreground)void this.restore().catch(()=>this.publish('waiting'));else void this.arm(this.pending);}}}
 accountChanged(){this.revision++;this.pending=undefined;this.armed.clear();this.publish('idle');}
 dispose(){this.disposed=true;this.accountChanged();this.listeners.clear();}
}
