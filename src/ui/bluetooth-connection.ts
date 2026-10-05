import type {ApplicationForegroundSync,ApplicationSyncEvent} from '../sync/application-foreground.ts';
import {remoteInputUrl,subscribeRemoteInput} from '../remote-input/inbox.ts';

export interface BluetoothConnectionState {status:string;detail:string|null;busy:boolean}
export interface BluetoothConnectionPorts {
 sync:Pick<ApplicationForegroundSync,'state'|'subscribe'|'refresh'>;
 radio:{status():Promise<{available:boolean;permission:string;enabled:boolean}>;requestPermission():Promise<string>};
 /** Defaults to the application inbox. Deliveries are observed, never consumed. */
 subscribeInput?:(observer:(url:string)=>void)=>()=>void;
}
export interface BluetoothConnectionOptions {
 abilityLabel?:string;
 returnRemoteUrl?:boolean;
 /** Lead must finish this page and coordinate the existing inbox consumer.
  * `return` resumes its caller; `add` opens Add RSS with this URL. */
 onUrl:(url:string,destination:'return'|'add')=>void;
}
const waiting=():BluetoothConnectionState=>({status:'等待手机蓝牙连接…',detail:'请在手机 Companion 中选择对应操作',busy:true});
/** Page lifetime only. The application retains ownership of listening and retries. */
export class BluetoothConnectionController {
 state:BluetoothConnectionState={status:'等待手机蓝牙连接…',detail:null,busy:false};
 private active=false;
 private awaiting=false;
 private version=0;
 private disposed=false;
 private stops:(()=>void)[]=[];
 constructor(private ports:BluetoothConnectionPorts,private options:BluetoothConnectionOptions,private changed:(state:BluetoothConnectionState)=>void){
  this.stops.push(ports.sync.subscribe(event=>this.event(event)));
  this.stops.push((ports.subscribeInput??subscribeRemoteInput)(value=>{
   if(!this.active||!this.awaiting)return;
   const url=remoteInputUrl(value);if(!url)return;
   this.awaiting=false;this.version++;
   this.set({status:'已收到 RSS 地址',detail:'正在打开添加页面…',busy:false});
   options.onUrl(url,options.returnRemoteUrl?'return':'add');
  }));
 }
 private set(state:BluetoothConnectionState){if(this.disposed)return;this.state=state;this.changed(state);}
 private fail(detail:string,status='蓝牙同步失败'){this.awaiting=false;this.version++;this.set({status,detail,busy:false});}
 setActive(active:boolean){if(this.disposed||this.active===active)return;this.active=active;if(active)void this.retry();else{this.version++;this.awaiting=false;}}
 async retry():Promise<void>{
  if(this.disposed||!this.active)return;
  const version=++this.version;
  const current=()=>!this.disposed&&this.active&&version===this.version;
  this.awaiting=false;
  try{
   let radio=await this.ports.radio.status();if(!current())return;
   if(!radio.available){this.fail('当前设备不支持蓝牙连接');return;}
   if(radio.permission!=='granted'){
    const permission=await this.ports.radio.requestPermission();if(!current())return;
    if(permission!=='granted'){this.fail('请允许蓝牙权限后重试','缺少蓝牙权限');return;}
    radio=await this.ports.radio.status();if(!current())return;
    if(radio.permission!=='granted'){this.fail('请允许蓝牙权限后重试','缺少蓝牙权限');return;}
   }
   if(!radio.enabled){this.fail('请开启蓝牙后重试');return;}
   this.awaiting=true;this.set(waiting());
   // Re-read platform facts after permission approval; never own/replace a listener.
   await this.ports.sync.refresh();if(!current())return;
   if(this.ports.sync.state==='disposed')this.fail('蓝牙连接服务已关闭');
   else if(this.ports.sync.state==='failed')this.fail('连接失败');
  }catch(error){if(current())this.fail(error instanceof Error?error.message:'连接失败');}
 }
 private event(event:ApplicationSyncEvent){
  if(!this.active||!this.awaiting||this.disposed)return;
  if(event.type==='error'){this.fail(event.message||'连接失败');return;}
  if(event.type==='state'){
   if(event.state==='disposed')this.fail('蓝牙连接服务已关闭');
   return; // Automatic listener restart must not erase a completed result.
  }
  if(!event.success){this.fail(event.message||'连接失败');return;}
  if(event.action==='remoteInput')return; // URL handoff comes from the shared inbox.
  this.awaiting=false;this.version++;
  if(event.action==='pullSavedItems')this.set({status:'已通过蓝牙同步',detail:`已向手机发送 ${event.count} 条${this.options.abilityLabel??'数据'}`,busy:false});
  else if(event.action==='syncLibrary')this.set({status:'蓝牙同步完成',detail:`收到 ${event.received} 条，应用 ${event.applied} 项变更`,busy:false});
  else this.set({status:'蓝牙连接成功',detail:'手机已完成握手',busy:false});
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.active=false;this.awaiting=false;this.version++;for(const stop of this.stops)stop();this.stops=[];}
}
