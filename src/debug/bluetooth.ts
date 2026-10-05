import type {DebugGate} from './gate.ts';
import type {SessionActionResult,LibrarySessionOptions} from '../sync/session.ts';
export function summarizePayload(label:string,payload:Record<string,unknown>):string{
 const count=(key:string)=>Array.isArray(payload[key])?(payload[key] as unknown[]).length:0;
 const index=Number(payload.batchIndex??-1),total=Number(payload.batchCount??-1);
 const range=payload.changeSeqRange as {fromExclusive?:number;toInclusive?:number}|undefined;
 return `${label}: action=${payload.action||'-'} phase=${payload.phase||'-'} version=${payload.version??0} success=${payload.success??true} articleManifest=${count('articleManifest')} articles=${count('articles')} bodyRequests=${count('bodyRequests')} rssSources=${count('rssSources')} batch=${index>=0&&total>0?`${index+1}/${total}`:'-'}${range?` seq=${range.fromExclusive??0}..${range.toInclusive??0}`:''}`;
}
export interface DebugBluetoothPorts {
 acquire():Promise<()=>void>;
 listener():{start(options:LibrarySessionOptions&{acceptTimeoutMs?:number;onPeer?:(peer:{remoteName:string|null;remoteAddress:string})=>void}):Promise<SessionActionResult[]>;stop():void};
 keepAwake(active:boolean):Promise<unknown>;
}
export class DebugBluetoothSession {
 private wake:Promise<unknown>=Promise.resolve();
 private setAwake(active:boolean){this.wake=this.wake.catch(()=>{}).then(()=>this.ports.keepAwake(active));return this.wake;}
 private closed=false;private busy=false;private listener?:ReturnType<DebugBluetoothPorts['listener']>;private job?:Promise<string>;
 constructor(private gate:DebugGate,private ports:DebugBluetoothPorts){}
 run(timeoutMs=120000):Promise<string>{
  this.gate.require();if(this.closed||this.busy)throw Error('Debug Bluetooth session unavailable');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw Error('超时必须为正整数毫秒');
  this.busy=true;return this.job=this.execute(timeoutMs);
 }
 private async execute(timeoutMs:number){
  let release:(()=>void)|undefined,peer='';
  try{
   release=await this.ports.acquire();
   if(this.closed)throw Error('Bluetooth sync cancelled');this.gate.require();
   this.listener=this.ports.listener();
   const results=await this.listener.start({acceptTimeoutMs:timeoutMs,onPeer:value=>{peer=`remote=${value.remoteName??''} ${value.remoteAddress}`;if(!this.closed)void this.setAwake(true).catch(()=>{});}});
   return ['Bluetooth sync request complete',peer,...results.flatMap(r=>[summarizePayload('request',r.request),summarizePayload('response',r.response)])].join('\n');
  }finally{this.listener=undefined;try{if(release)await this.setAwake(false);}finally{release?.();this.busy=false;}}
 }
 async close(){this.closed=true;this.listener?.stop();await this.job?.catch(()=>{});}
}
