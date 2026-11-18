import type {DeviceInfo} from '@podjs/framework/services';

export interface DeviceProfileStorage {get(key:string):unknown;set(key:string,value:unknown):void}
export interface DeviceProfileReport {
 anonymousDeviceId:string;activeDays:string[];deviceInfo:DeviceInfo;
 appVersionName:string;appVersionCode:number;privacyPolicyVersion:number;
}
export interface DeviceProfilePorts {
 consented():boolean;buildInfo():Promise<{debugBuild:boolean}>;info():Promise<DeviceInfo>;
 identity():Promise<string>;send(report:DeviceProfileReport):Promise<{acceptedDays:string[]}>;
 random():number;now():number;after(ms:number,callback:()=>void):()=>void;
 versionName:string;versionCode:number;privacyPolicyVersion:number;
}
const KEY='watchrss.telemetry.device-profile.v1',DAY=86400000,OFFSET=8*3600000;
export const deviceProfileDay=(now:number)=>new Date(now+OFFSET).toISOString().slice(0,10);
interface Saved {days:string[];pending:string[]}

/** Account-independent, consent-gated daily presence. No background wakeups. */
export class WatchDeviceProfileTelemetry {
 private active=false;private stopped=false;private disabled=false;private foregroundGeneration=0;
 private running?:Promise<void>;private cancelTimer?:()=>void;
 private metadata?:DeviceInfo;private retryAt=0;
 constructor(private readonly storage:DeviceProfileStorage,private readonly ports:DeviceProfilePorts){}
 refresh(active=this.active,_reconnected=false):Promise<void>{
  const entered=active&&!this.active;
  this.active=active;this.cancelTimer?.();this.cancelTimer=undefined;
  if(this.stopped||!active)return Promise.resolve();
  // Every foreground entry gets fresh jitter, even when an old timer expired
  // in the background. Connectivity/account callbacks cannot bypass it.
  if(entered){this.foregroundGeneration++;this.retryAt=this.nextUploadAt();}
  if(this.running)return this.running;
  this.running=this.captureAndSend().finally(()=>{this.running=undefined;this.schedule();});
  return this.running;
 }
 stop(){this.stopped=true;this.active=false;this.cancelTimer?.();}
 private nextUploadAt(){return this.ports.now()+(30+150*Math.max(0,Math.min(1,this.ports.random())))*60000;}
 private load():Saved {
  const first=deviceProfileDay(this.ports.now()-6*DAY),today=deviceProfileDay(this.ports.now());
  const raw=this.storage.get(KEY);let saved:Partial<Saved>={};
  try{if(typeof raw==='string')saved=JSON.parse(raw);else if(raw&&typeof raw==='object')saved=raw as Saved;}catch{}
  const valid=(values:unknown)=>Array.isArray(values)?[...new Set(values.filter((v):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>=first&&v<=today))].sort():[];
  const days=valid(saved?.days);return {days,pending:valid(saved?.pending).filter(day=>days.includes(day))};
 }
 private save(value:Saved){this.storage.set(KEY,JSON.stringify(value));}
 private async captureAndSend(){
  const generation=this.foregroundGeneration;
  try{
   // Check consent before even reading the host's product metadata or random ID.
   if(this.disabled||!this.ports.consented())return;
   if(!this.metadata){
    const build=await this.ports.buildInfo();
    if(build.debugBuild!==false){this.disabled=true;return;}
    if(generation!==this.foregroundGeneration||!this.active||this.stopped||!this.ports.consented())return;
    const info=await this.ports.info();
    this.metadata=Object.fromEntries(['brand','manufacturer','model','device','product'].map(key=>[key,String(info[key as keyof DeviceInfo]??'').slice(0,128)])) as unknown as DeviceInfo;
   }
   if(generation!==this.foregroundGeneration||!this.active||this.stopped||!this.ports.consented())return;
   const saved=this.load(),today=deviceProfileDay(this.ports.now());
   if(!saved.days.includes(today)){saved.days.push(today);saved.pending.push(today);}
   this.save(saved);
   if(!saved.pending.length)return;
   if(!this.retryAt)this.retryAt=this.nextUploadAt();
   if(this.ports.now()<this.retryAt)return;
   // Send one deduplicated day, never the account snapshot backlog batch.
   const activeDays=[saved.pending[0]!];
   const anonymousDeviceId=await this.ports.identity();
   // Identity creation crosses host IO. A resume owns a new deadline and
   // generation; this old task must not dispatch on that foreground's behalf.
   if(generation!==this.foregroundGeneration||!this.active||this.stopped||!this.ports.consented()||this.ports.now()<this.retryAt)return;
   const result=await this.ports.send({anonymousDeviceId,activeDays,deviceInfo:this.metadata,
    appVersionName:this.ports.versionName,appVersionCode:this.ports.versionCode,privacyPolicyVersion:this.ports.privacyPolicyVersion});
   if(!Array.isArray(result.acceptedDays)||!result.acceptedDays.every(day=>typeof day==='string'&&activeDays.includes(day)))throw Error('Invalid device profile acknowledgement');
   // A concurrent lifecycle callback may have recorded another day: remove only acknowledgements.
   const current=this.load();current.pending=current.pending.filter(day=>!result.acceptedDays.includes(day));this.save(current);
   this.retryAt=current.pending.length?this.nextUploadAt():0;
  }catch(error){
   if(generation!==this.foregroundGeneration)return;
   if((error as {code?:string})?.code==='unsupported'){this.disabled=true;return;}
   this.retryAt=this.nextUploadAt();
  }
 }
 private schedule(){
  if(!this.active||this.stopped||this.disabled||!this.ports.consented())return;
  const now=this.ports.now(),midnight=DAY-((now+OFFSET)%DAY);
  // A request may finish on the next day before a midnight timer exists.
  const rollover=this.retryAt<=now&&this.metadata&&!this.load().days.includes(deviceProfileDay(now))?1000:midnight;
  // A stale identity may finish after the new deadline. Queue a fresh task
  // promptly rather than letting the stale task send or waiting until midnight.
  const due=this.metadata&&this.load().pending.length>0;
  const retry=this.retryAt>now?this.retryAt-now:due?1000:rollover;
  this.cancelTimer=this.ports.after(Math.max(1000,Math.min(midnight,retry)),()=>{void this.refresh();});
 }
}
