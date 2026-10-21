import {base64ToBytes} from '@podjs/framework/bytes';
import {utf8Decode} from '../cloud/types';
/** Watch-side pairing run for the WeChat mini program: one owned host session at a time.
 * Pairing uses the encrypted internet channel. Business validation stays in WatchSetupHandler. */
export type PairingTransport='internet'|'bluetooth';
export type PairingStep='scanned'|'confirmed'|'saving'|'cloud';
export const PAIRING_STEPS:readonly {step:PairingStep;label:string}[]=[
 {step:'scanned',label:'手机已扫码'},{step:'confirmed',label:'已确认账号'},{step:'saving',label:'保存账号'},{step:'cloud',label:'开启云同步'},
];
export type PairingState=
 |{kind:'idle'}
 |{kind:'starting';transport:PairingTransport}
 |{kind:'permission';denied:boolean}
 |{kind:'scan';transport:PairingTransport;qr:string;expiresAt:number}
 |{kind:'confirm';account:string;sas:string;phoneMaskedTrusted:false}
 |{kind:'working';step:PairingStep}
 /** Only after the account (and optionally the cloud key) was durably saved. */
 |{kind:'done';cloudReady:boolean}
 |{kind:'failed';title:string;detail:string;suggestOther:boolean;needsUpgrade?:boolean;needsReregistration?:boolean}
 |{kind:'cancelled'}
 |{kind:'paused'};
export const isLivePairing=(state:PairingState)=>state.kind==='starting'||state.kind==='scan'||state.kind==='confirm'||state.kind==='working';

export interface PairingOperation<T>{result:Promise<T>;cancel():void}
export interface PairingHandler{handle(message:Record<string,any>):Promise<Record<string,unknown>>}
export interface PairingPorts{
 op<T>(method:string,args:Record<string,unknown>):PairingOperation<T>;
 available():boolean;
 identity():Promise<{deviceId:string;installId:string}>;
 handler(ports:{deviceId:string;installId:string;active:()=>boolean;pairing:{sessionId:string;secret:Uint8Array};confirm:(label:string,sas:string)=>Promise<boolean>}):Promise<PairingHandler>;
 now():number;
 after(ms:number,fn:()=>void):()=>void;
}
export const PAIRING_LIFETIME_MS=300_000,PAIRING_CONFIRM_MS=90_000,PAIRING_FINISH_GRACE_MS=20_000;

export const pairingStartingLabel=(_transport:PairingTransport)=>'正在生成配对码…';
export const pairingScanHint=(_transport:PairingTransport)=>'在微信打开腕上RSS小程序，点“添加手表”扫码';
export const pairingDoneTitle=(cloudReady:boolean)=>cloudReady?'全部设置完成':'手表已绑定';
export const pairingDoneDetail=(cloudReady:boolean)=>cloudReady?'账号已登录，云同步已开启':'账号已登录，可在“我的 → 云同步”查看当前状态';
export function pairingCountdown(remainingMs:number){const seconds=Math.max(0,Math.ceil(remainingMs/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} 后失效`;}

/** Plain words only; host codes, limits and server details never reach the screen. */
export function pairingFailure(error:unknown,transport:PairingTransport,qrShown:boolean):Extract<PairingState,{kind:'failed'}>{
 const code=String((error as {code?:unknown})?.code??''),reason=String(error);
 if(reason.includes('client_upgrade_required'))return{kind:'failed',title:'请升级腕上RSS',detail:'升级后重新开始配对',suggestOther:false,needsUpgrade:true};
 if(reason.includes('device_key_conflict'))return{kind:'failed',title:'需要重新登记本机',detail:'请先在云同步中确认重新登记，再重新配对',suggestOther:false,needsReregistration:true};
 if(code==='provision_offline')return{kind:'failed',title:'手表没连上网络',detail:'请检查手表网络后重试',suggestOther:false};
 if(code==='provision_expired')return{kind:'failed',title:'配对码已过期',detail:'重新生成一个即可',suggestOther:false};
 if(code==='provision_closed'||qrShown)return{kind:'failed',title:'连接已断开',detail:'请重新开始，再用小程序扫码',suggestOther:false};
 return{kind:'failed',title:'配对没有完成',detail:'请重新开始配对',suggestOther:false};
}

export class MiniProgramPairing{
 transport:PairingTransport;
 private state:PairingState={kind:'idle'};
 private epoch=0;private foreground=true;private disposed=false;
 private secret?:Uint8Array;private sessionId='';private pending:PairingOperation<unknown>|undefined;
 private approval:((value:boolean)=>void)|undefined;private cancelTimers:(()=>void)[]=[];
 private outcome:'pending'|'approved'|'declined'|'timeout'='pending';
 private bound=false;private cloud=false;
 constructor(private readonly ports:PairingPorts,private readonly onState:(state:PairingState)=>void,transport:PairingTransport='internet'){this.transport='internet';}
 current(){return this.state;}
 private emit(state:PairingState){this.state=state;this.onState(state);}

 /** Explicit user action only; never called from rendering. */
 start(){
  if(this.disposed||!this.foreground)return;
  this.stop();
  if(!this.ports.available()){this.emit({kind:'failed',title:'暂不支持扫码配对',detail:'请更新手表上的腕上RSS后再试',suggestOther:false});return;}
  const epoch=this.epoch;this.bound=false;this.cloud=false;this.outcome='pending';
  this.emit({kind:'starting',transport:this.transport});
  void this.run(epoch);
 }
 /** The copied account-only button cannot assert SAS agreement. Lead's new SAS UI calls confirmSas. */
 confirm(){return false;}
 confirmSas(matches:boolean){const approve=this.approval;if(!approve||this.state.kind!=='confirm')return false;if(matches)this.emit({kind:'working',step:'saving'});approve(matches);return true;}
 decline(){this.approval?.(false);}
 /** Returns true when the page should close (nothing happened yet). */
 cancel():boolean{
  if(this.bound){this.stop({kind:'done',cloudReady:this.cloud});return false;}
  const kind=this.state.kind,live=isLivePairing(this.state);
  this.stop(live&&kind!=='starting'&&kind!=='scan'?{kind:'cancelled'}:undefined);
  return !live||kind==='starting'||kind==='scan';
 }
 setForeground(foreground:boolean){
  this.foreground=foreground;
  if(foreground)return;
  if(this.bound)this.stop({kind:'done',cloudReady:this.cloud});
  else if(isLivePairing(this.state))this.stop({kind:'paused'});
  else this.stop();
 }
 dispose(){this.disposed=true;this.stop();}

 /** Ends the owned session and rejects a pending confirmation. */
 private stop(next?:PairingState){
  this.epoch++;this.secret?.fill(0);this.secret=undefined;
  this.approval?.(false);
  for(const cancel of this.cancelTimers.splice(0))cancel();
  this.pending?.cancel();this.pending=undefined;
  const id=this.sessionId;this.sessionId='';
  if(id)void this.ports.op('provision.close',{sessionId:id}).result.catch(()=>{});
  if(next)this.emit(next);
 }
 private async call<T>(method:string,args:Record<string,unknown>,active:()=>boolean):Promise<T>{
  if(!active())throw Error('cancelled');
  const task=this.ports.op<T>(method,{...args,...(this.sessionId?{sessionId:this.sessionId}:{})});
  this.pending=task as PairingOperation<unknown>;
  try{return await task.result;}finally{if(this.pending===task)this.pending=undefined;}
 }
 private ask(label:string,sas:string,active:()=>boolean):Promise<boolean>{
  return new Promise(resolve=>{
   if(!active()||!/^\d{8}$/.test(sas)){resolve(false);return;}
   this.outcome='pending';
   const finish=(value:boolean)=>{
    if(this.approval!==finish)return;
    this.approval=undefined;expire();
    if(this.outcome==='pending')this.outcome=value?'approved':'declined';
    resolve(value);
   };
   const expire=this.ports.after(PAIRING_CONFIRM_MS,()=>{this.outcome='timeout';finish(false);});
   this.cancelTimers.push(expire);this.approval=finish;
   this.emit({kind:'confirm',account:label,sas,phoneMaskedTrusted:false});
  });
 }

 private async run(epoch:number){
  const transport:PairingTransport='internet',active=()=>!this.disposed&&this.foreground&&this.epoch===epoch;
  const show=(state:PairingState)=>{if(active())this.emit(state);};
  let qrShown=false;
  try{
   const {deviceId,installId}=await this.ports.identity();
   const opened=await this.call<{qr:string;sessionId:string}>('provision.start',{deviceId,installId,transport},active);
   if(!active()){void this.ports.op('provision.close',{sessionId:opened.sessionId}).result.catch(()=>{});return;}
   this.sessionId=opened.sessionId;qrShown=true;
   show({kind:'scan',transport,qr:opened.qr,expiresAt:this.ports.now()+PAIRING_LIFETIME_MS});
   const pairing=pairingContext(opened.qr,opened.sessionId,deviceId,installId);this.secret=pairing.secret;
   const handler=await this.ports.handler({deviceId,installId,active,pairing,confirm:(label,sas)=>this.ask(label,sas,active)});
   while(active()){
    const message=await this.call<Record<string,any>>('provision.receive',{},active);
    if(!active())return;
    let result:Record<string,unknown>,stopWith:PairingState|undefined,failed=false;
    try{
     result=await handler.handle(message);
     if(!active())return;
     if(message.action==='configure'){if(result.bound!==true)throw Error('binding_not_verified');this.bound=true;this.cloud=result.cloudReady===true;show({kind:'working',step:'cloud'});}
     if(message.action==='key'){this.cloud=result.cloudReady===true;if(!this.cloud)throw Error('waiting_approval');}
    }catch(error){
     if(!active())return;
     // WatchSetupHandler reports these two by message; both are worth telling the user plainly.
     const reason=String((error as Error)?.message??'');const conflict=reason.includes('其他账号')||reason.includes('account_switch_rejected');
     if(message.action==='prepare'&&this.outcome==='timeout')stopWith={kind:'failed',title:'等待确认超时',detail:'请重新开始配对',suggestOther:false};
     else if(message.action==='prepare'&&this.outcome==='declined')stopWith={kind:'cancelled'};
     else if(conflict)stopWith={kind:'failed',title:'手表已登录其他账号',detail:'请先在手表上退出原账号，再重新配对',suggestOther:false};
     if(message.action==='key'||message.action==='finish')this.cloud=false;
     if(reason.includes('client_upgrade_required')||reason.includes('device_key_conflict'))stopWith=pairingFailure(error,transport,qrShown);
     failed=true;
     result={success:false,message:stopWith?.kind==='cancelled'?'已在手表上取消绑定':conflict?'手表已绑定其他账号，请先在手表退出原账号':'配置未完成，请检查手表账号后重试'};
    }
    await this.call('provision.respond',{sequence:message._sequence,result},active);
    if(stopWith){this.stop(this.bound?{kind:'done',cloudReady:this.cloud}:stopWith);return;}
    if(failed){show(this.bound?{kind:'done',cloudReady:this.cloud}:{kind:'failed',title:'配对没有完成',detail:'请重新开始配对',suggestOther:false});continue;}
    if(message.action==='finish'){
     this.cloud=result.cloudReady===true;
     show({kind:'done',cloudReady:this.cloud});
     // Let the phone collect the final receipt, then end the session; the page stays on done.
     this.cancelTimers.push(this.ports.after(PAIRING_FINISH_GRACE_MS,()=>{if(this.epoch===epoch)this.stop();}));
    }
   }
  }catch(error){
   if(!active())return;
   this.stop(this.bound?{kind:'done',cloudReady:this.cloud}:pairingFailure(error,transport,qrShown));
  }
 }
}

/** The live host QR is the source of R6 context; never substitute an unrelated key/session. */
export function pairingContext(qr:string,sessionId:string,deviceId:string,installId:string){
 if(!qr.startsWith('wrss-pair:'))throw Error('invalid_pairing_context');const raw=qr.slice(10).replace(/-/g,'+').replace(/_/g,'/'),d=JSON.parse(utf8Decode(base64ToBytes(raw+'='.repeat((4-raw.length%4)%4))));
 const secret=base64ToBytes(d.secret);if(d.sessionId!==sessionId||d.deviceId!==deviceId||d.installId!==installId||secret.length!==32){secret.fill(0);throw Error('invalid_pairing_context');}return{sessionId,secret};
}
