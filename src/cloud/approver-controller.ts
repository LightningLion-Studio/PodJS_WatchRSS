import {CloudRequestError} from './client';
import {WatchCloudApprover,type ApproverDisplay,type ApproverPhase,type ApproverSession,type PendingApproval} from './approver';
import type {ApproverCrypto} from './approver-crypto';

export interface CloudApproverRequest {requestId:string;requesterLabel:string;expiresAt:number}
export type CloudApproverState=ApproverDisplay & {requests:CloudApproverRequest[];message:string};
export const idleApprover=():CloudApproverState=>({phase:'idle',requests:[],message:''});
const messages:Record<ApproverPhase,string>={idle:'',requested:'有新设备请求授权',accepting:'正在开始核对',waiting:'等待新设备揭示授权码',code:'请核对两端的 8 位授权码',delivering:'正在交付设备授权',complete:'设备授权已完成',cancelled:'已取消授权',expired:'授权已过期',error:'授权未完成，请重新发起',unsupported:'服务端暂不支持手表批准授权'};
const terminal=(phase:ApproverPhase)=>['complete','cancelled','expired','error'].includes(phase);
/** UI API: state/subscribe, poll(), accept(requestId), confirm(match), cancel(),
 * setForeground(active), reset(). Caller owns a 5 s foreground cloud-page timer.
 * Pending discovery never accepts a request or delivers keys automatically. */
export class CloudApproverController {
 private value=idleApprover();private listeners=new Set<()=>void>();private targets:PendingApproval[]=[];private machine?:WatchCloudApprover;
 private foreground=false;private generation=0;private visibility=0;private flight?:Promise<boolean>;
 constructor(private p:{open(check:()=>void):Promise<ApproverSession|undefined>;crypto:ApproverCrypto}){}
 get state():CloudApproverState{return {...this.value,requests:this.value.requests.map(row=>({...row}))};}
 get active(){return this.foreground&&this.value.phase!=='unsupported';}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private set(state:CloudApproverState){this.value=state;for(const fn of this.listeners)try{fn();}catch{}}
 private display=(state:ApproverDisplay)=>this.set({...state,requests:[],message:messages[state.phase]});
 setForeground(active:boolean){if(this.foreground!==active)this.visibility++;this.foreground=active;}
 reset(){this.generation++;this.visibility++;this.machine?.dispose();this.machine=undefined;this.targets=[];this.flight=undefined;this.set(idleApprover());}
 private run(action:(s:ApproverSession,check:()=>void)=>Promise<void>):Promise<boolean>{
  if(this.flight)return this.flight;if(!this.active)return Promise.resolve(false);
  const generation=this.generation,visibility=this.visibility;
  const check=()=>{if(generation!==this.generation||visibility!==this.visibility||!this.foreground)throw Error('approval_paused');};
  const task=(async()=>{try{const s=await this.p.open(check);check();if(!s){this.machine?.dispose();this.machine=undefined;this.targets=[];this.set(idleApprover());return false;}await action(s,check);check();return true;}
   catch(error){if(generation!==this.generation)return false;
    if(error instanceof CloudRequestError&&error.status===403&&error.code==='phone_approval_required'){this.machine?.dispose();this.machine=undefined;this.targets=[];this.display({phase:'unsupported'});return false;}
    if(visibility!==this.visibility||!this.foreground)return false;
    this.machine?.dispose();this.machine=undefined;this.targets=[];this.display({phase:String(error).includes('approval_expired')?'expired':'error'});return false;
   }})();
  this.flight=task;void task.finally(()=>{if(this.flight===task)this.flight=undefined;});return task;
 }
 poll(){return this.run(async(s,check)=>{
  if(this.machine&&!terminal(this.value.phase)){await this.machine.poll(s);return;}
  const data=await s.client.approvalPending();await s.assertCurrent();check();
  if(!Array.isArray(data.requests))throw Error('invalid_approval');
  this.targets=data.requests.filter((r:PendingApproval)=>r&&r.deviceId!==s.deviceId&&!r.deviceId?.startsWith('reader-migration-')).map((r:PendingApproval)=>{
   if(typeof r.requestId!=='string'||!r.requestId||typeof r.deviceId!=='string'||!r.deviceId||typeof r.publicKeySpki!=='string'||!/^[0-9a-f]{64}$/.test(r.commitment)||!Number.isFinite(r.expiresAt)||r.expiresAt<=0)throw Error('invalid_approval');
   return {...r,displayName:typeof r.displayName==='string'?r.displayName.slice(0,60):'新设备'};
  });
  const phase=this.targets.length?'requested':'idle';this.set({phase,message:messages[phase],requests:this.targets.map(r=>({requestId:r.requestId,requesterLabel:r.displayName||'新设备',expiresAt:r.expiresAt}))});
 });}
 accept(requestId:string){
  if(this.flight||!this.active||this.machine&&!terminal(this.value.phase))return Promise.resolve(false);
  const target=this.targets.find(r=>r.requestId===requestId);if(!target)return Promise.resolve(false);
  return this.run(async s=>{const generation=this.generation;this.machine?.dispose();this.machine=new WatchCloudApprover(target,s,this.p.crypto,state=>{if(generation===this.generation)this.display(state);});this.targets=[];await this.machine.accept(s);});
 }
 confirm(match:boolean){if(match===false)return this.cancel();if(match!==true||this.flight||this.value.phase!=='code')return Promise.resolve(false);return this.run(async s=>{await this.machine!.confirm(s);});}
 async cancel(){
  if(this.value.phase==='unsupported')return false;
  if(this.value.phase==='delivering')return false;
  const machine=this.machine,previous=this.flight;this.generation++;this.flight=undefined;this.targets=[];this.machine=undefined;
  // Stop key wrapping immediately, even when an old bootstrap/wrap is in flight.
  machine?.dispose();this.display({phase:'cancelled'});
  if(!machine||!this.foreground)return true;
  try{const generation=this.generation;await previous;const check=()=>{if(generation!==this.generation||!this.foreground)throw Error('approval_paused');};const s=await this.p.open(check);check();await machine.cancel(s);return true;}catch{return false;}
 }
}
