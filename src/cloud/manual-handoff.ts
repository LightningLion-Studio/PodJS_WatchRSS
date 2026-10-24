import type {CloudHostRequest} from './host-ports';
let localTransferRevision=0;
export const MANUAL_INTENT_KEY='watchrss.cloud.manual.v1';
export type ManualMode='all'|'recent128';
export interface ManualIntent {version:1;token:string;scope:string;mode:ManualMode;createdAt:number}
export function readManualIntent(raw:unknown):ManualIntent|undefined{try{const value=typeof raw==='string'?JSON.parse(raw):raw;if(value?.version===1&&typeof value.token==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(value.token)&&typeof value.scope==='string'&&value.scope.length<=2048&&['all','recent128'].includes(value.mode)&&Number.isFinite(value.createdAt)&&value.createdAt>=0)return value;}catch{}return;}
/** Page navigation is irrelevant. Only actual application backgrounding hands
 * off; the foreground execution fence remains permanent for the old run. */
export class CloudManualHandoff {
 private pending:ManualIntent|undefined;private foreground=true;private held=false;private serial=Promise.resolve();private revision=0;
 private queued=new Set<string>();
 private phase:'idle'|'foreground'|'queued'|'held'='idle';private listeners=new Set<()=>void>();
 constructor(private readonly host:CloudHostRequest,private readonly scope:()=>Promise<string|undefined>,private readonly run:(mode:ManualMode)=>Promise<boolean>,private readonly now=Date.now){}
 get state(){return {phase:this.phase,mode:this.pending?.mode,createdAt:this.pending?.createdAt};}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private publish(phase:typeof this.phase){this.phase=phase;for(const fn of this.listeners)fn();}
 private write<T>(operation:()=>Promise<T>):Promise<T>{const result=this.serial.then(operation,operation);this.serial=result.then(()=>{},()=>{});return result;}
 private async enqueue(intent:ManualIntent){if(this.pending!==intent||this.foreground||this.queued.has(intent.token))return;this.queued.add(intent.token);try{await this.host('cloud.enqueue',{token:intent.token});}catch(error){this.queued.delete(intent.token);throw error;}if(this.pending===intent)this.publish(this.held?'held':'queued');}
 async manual(mode:ManualMode='recent128'){
  const revision=++this.revision,scope=await this.scope();if(!scope||revision!==this.revision)return false;
  const random=await this.host<{bytesBase64:string}>('crypto.random',{bytes:18});if(revision!==this.revision)return false;
  const intent:ManualIntent={version:1,token:random.bytesBase64.replace(/[^a-zA-Z0-9_-]/g,'_'),scope,mode:this.pending?.mode==='all'?'all':mode,createdAt:this.now()};
  await this.write(async()=>{if(revision!==this.revision)return;await this.host('secure.set',{key:MANUAL_INTENT_KEY,value:JSON.stringify(intent)});this.pending=intent;});
  if(this.pending!==intent)return false;
  if(!this.foreground){await this.enqueue(intent);return false;}
  this.publish(this.held?'held':'foreground');const success=await this.run(intent.mode);
  if(success)await this.complete(intent,true);
  else if(!this.foreground)await this.enqueue(intent);
  return success;
 }
 /** A scheduler-held manual run may finish after the original manual() promise
  * returned. Capture its intent at run start so it cannot clear a newer grant. */
 captureCompletion(){const intent=this.pending;return(success:boolean)=>intent?this.complete(intent,success):Promise.resolve();}
 private async complete(intent:ManualIntent,success:boolean){if(!success)return;await this.write(async()=>{if(this.pending!==intent)return;const stored=await this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});if(readManualIntent(stored.value)?.token===intent.token)await this.host('secure.delete',{key:MANUAL_INTENT_KEY});this.pending=undefined;this.queued.clear();this.publish('idle');});}
 foregroundChanged(active:boolean){this.foreground=active;if(active&&this.pending){const intent=this.pending;void this.host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY}).then(stored=>{if(this.pending===intent&&readManualIntent(stored.value)?.token!==intent.token){this.pending=undefined;this.publish('idle');}}).catch(()=>{});}if(!active&&this.pending)void this.enqueue(this.pending).catch(()=>{});}
 localTransferChanged(active:boolean){this.held=active;void this.host('cloud.localTransfer',{active,generation:++localTransferRevision}).catch(()=>{});if(this.pending)this.publish(active?'held':this.foreground?'foreground':'queued');}
 accountChanged(){this.revision++;this.pending=undefined;this.queued.clear();this.publish('idle');}
 dispose(){this.revision++;this.pending=undefined;this.listeners.clear();}
}
