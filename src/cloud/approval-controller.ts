import type {ApprovalStatus,WatchCloudApproval} from './approval';
import type {createCloudAuthorization} from './authorization';
export type CloudApprovalState=Omit<ApprovalStatus,'phase'> & {phase:ApprovalStatus['phase']|'requesting';message:string;expiresAt?:number}
export const idleApproval=():CloudApprovalState=>({phase:'idle',message:''});
const messages:Record<ApprovalStatus['phase'],string>={idle:'',pending:'等待已授权设备开始核对',code:'请核对两端的 8 位授权码',committing:'正在保存授权',complete:'设备授权已完成',cancelled:'已取消授权',expired:'授权已过期，请重新请求',error:'授权验证失败，请重新请求'};
/** Owns only the v2 requester. No code input, redeem endpoint, nonce or tokens in display state. */
export class CloudApprovalController {
 private value:CloudApprovalState=idleApproval();private listeners=new Set<()=>void>();private generation=0;private machine?:WatchCloudApproval;private flight?:Promise<boolean>;private foreground=true;private synced=false;
 constructor(private p:{open():Promise<Pick<ReturnType<typeof createCloudAuthorization>,'approval'>|undefined>;sync():Promise<unknown>}){}
 get state(){return{...this.value};}get active(){return this.foreground;}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private set(state:CloudApprovalState){this.value=state;for(const fn of this.listeners)try{fn();}catch{}}
 private update(state:ApprovalStatus){this.set({...state,message:messages[state.phase],...(this.machine?.expiresAt?{expiresAt:this.machine.expiresAt}:{})});}
 reset(){this.generation++;if(this.machine){void this.machine.cancel().catch(()=>{});this.machine.dispose();}this.machine=undefined;this.flight=undefined;this.synced=false;this.set(idleApproval());}
 setForeground(active:boolean){this.foreground=active;this.machine?.setForeground(active);}
 request():Promise<boolean>{
  if(this.flight)return this.flight;if(!this.foreground||this.value.phase==='committing')return Promise.resolve(false);
  if(this.machine){void this.machine.cancel().catch(()=>{});this.machine.dispose();}const epoch=++this.generation;this.synced=false;this.set({...idleApproval(),phase:'requesting',message:'正在请求设备授权'});
  const run=(async()=>{try{const auth=await this.p.open();if(epoch!==this.generation)return false;if(!auth)throw Error('account_missing');const machine=await auth.approval(s=>{if(epoch===this.generation)this.update(s);});if(epoch!==this.generation){machine.dispose();return false;}this.machine=machine;machine.setForeground(this.foreground);await machine.start();return epoch===this.generation;}catch(error){if(epoch===this.generation&&this.machine?.status.phase!=='cancelled')this.set({phase:'error',message:String(error).includes('client_upgrade_required')?'请升级腕上RSS以继续云同步':String(error).includes('device_key_conflict')?'设备公钥冲突，请重新登记本机':'暂时无法请求授权，请重试'});return false;}})();
  this.flight=run;void run.finally(()=>{if(this.flight===run)this.flight=undefined;});return run;
 }
 private async perform(action:(machine:WatchCloudApproval)=>Promise<void>){const machine=this.machine,epoch=this.generation;if(!machine)return false;try{await action(machine);if(epoch!==this.generation)return false;if(machine.status.phase==='complete'&&!this.synced){this.synced=true;await this.p.sync();}return true;}catch{if(epoch===this.generation)this.update(machine.status);return false;}}
 poll(){return this.perform(machine=>machine.poll());}
 confirmMatches(matches:boolean){return this.perform(machine=>machine.confirmCode(matches));}
 cancel(){if(!this.machine&&this.flight){this.generation++;this.flight=undefined;this.set({phase:'cancelled',message:messages.cancelled});return Promise.resolve(true);}return this.perform(machine=>machine.cancel());}
}
