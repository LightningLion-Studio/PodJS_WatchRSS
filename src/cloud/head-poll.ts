import {sha256Hex} from '@podjs/framework/crypto';
import {SyncV2Lifetime} from '../sync-v2/lifetime';
import {utf8Decode,utf8Encode,type HttpResponse,type HttpTransport} from './types';

const DEFAULT_INTERVAL=20_000;
const MAX_BACKOFF=300_000;
const DEFAULT_CONFIG_TTL=600_000;
const CONFIG_KEY='sync_head_poll_v1';
const DEFAULT_ENABLED=true;

function header(response:HttpResponse,name:string){
 return Object.entries(response.headers).find(([key])=>key.toLowerCase()===name)?.[1];
}

function positiveMillis(value:unknown):number|undefined{
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;
}

function json(response:HttpResponse){
 const value=JSON.parse(utf8Decode(response.body));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_head_response');
 return value;
}

function headErrorCode(response:HttpResponse):unknown{
 try{return json(response).error?.code;}catch{return undefined;}
}

export async function requestAccountHead(transport:HttpTransport,origin:string,token:string,deviceId:string){
 // The locked Android host treats a 304 as a redirect. Compare the small
 // unconditional response locally until that host supports conditional GET.
 return transport.request({method:'GET',url:origin+'/functions/v1/sync/v2/account/head',
  headers:{Authorization:'Bearer '+token,'x-watchrss-cloud-device-id':deviceId}});
}

export async function requestHeadPollConfig(transport:HttpTransport,origin:string,versionCode:number,installId:string){
 const url=origin+'/functions/v1/client-config?platform=watch&appVersionCode='+versionCode+
  (installId?'&installId='+encodeURIComponent(installId):'');
 const response=await transport.request({method:'GET',url,headers:{}});
 if(response.status!==200)return;
 const {features,ttlSeconds}=json(response);
 if(!features||typeof features!=='object'||Array.isArray(features))return;
 const ttl=positiveMillis(ttlSeconds);
 const ttlMs=ttl?Math.min(ttl,600)*1000:DEFAULT_CONFIG_TTL;
 const rule=features[CONFIG_KEY];
 if(rule===undefined)return {enabled:DEFAULT_ENABLED,ttlMs};
 const {percent,salt,minAppVersionCode,maxAppVersionCode,forced}=rule??{};
 if(!Number.isInteger(percent)||percent<0||percent>100||typeof salt!=='string'||!salt||
    !Number.isInteger(minAppVersionCode)||minAppVersionCode<0||
    (maxAppVersionCode!==null&&(!Number.isInteger(maxAppVersionCode)||maxAppVersionCode<minAppVersionCode))||
    ![null,'off','on'].includes(forced))return;
 const eligible=percent>0&&versionCode>=minAppVersionCode&&(maxAppVersionCode===null||versionCode<=maxAppVersionCode);
 const bucket=Number.parseInt(sha256Hex(utf8Encode(salt+':'+installId)).slice(0,4),16)%100;
 return {enabled:eligible&&forced!=='off'&&(forced==='on'||bucket<percent),ttlMs};
}

type HeadPollConfig={enabled:boolean;ttlMs:number};
interface HeadPollPorts {
 eligible():boolean;
 now():number;
 delay(ms:number,callback:()=>void):()=>void;
 read(kind:'config'|'head',lifetime:SyncV2Lifetime):Promise<HttpResponse|HeadPollConfig|undefined>;
 sync():Promise<boolean>;
 onPolicyChanged?():void;
}

/** The legacy scheduler remains responsible for edits, retries and writers.
 * A head comparison holds only in-memory state and never publishes UI status. */
export class WatchHeadPoll {
 private revision=0;
 private unsupported=false;
 private enabled=DEFAULT_ENABLED;
 private configDue=0;
 private headDue?:number;
 private interval=DEFAULT_INTERVAL;
 private failures=0;
 private etag?:string;
 private running=false;
 private timer?:{at:number;cancel:()=>void};
 private reading?:{leased:boolean;lifetime:SyncV2Lifetime;task:Promise<HttpResponse|HeadPollConfig|undefined>};
 constructor(private readonly ports:HeadPollPorts){}

 get expediteMemos(){return this.configDue!==0&&this.enabled&&!this.unsupported;}

 update(){
  if(this.unsupported||!this.ports.eligible()){
   this.clearTimer();
   this.reading?.lifetime.cancel();
   if(!this.failures)this.headDue=undefined;
   return;
  }
  if(this.running)return;
  const now=this.ports.now();
  if(this.enabled)this.headDue??=now+this.jitter(this.interval);
  const at=Math.min(this.configDue,this.enabled?this.headDue!:Infinity);
  if(this.timer?.at===at)return;
  this.clearTimer();
  const timer={at,cancel:()=>{}};
  this.timer=timer;
  timer.cancel=this.ports.delay(Math.max(0,at-now),()=>{
   if(this.timer!==timer)return;
   this.timer=undefined;
   // The Android timer caps each wait at two minutes.
   if(this.ports.now()<at){this.update();return;}
   void this.tick().catch(()=>{});
  });
 }

 resetAccount(){
  this.revision++;
  this.clearTimer();
  this.reading?.lifetime.cancel();
  this.enabled=DEFAULT_ENABLED;
  this.configDue=0;
  this.headDue=undefined;
  this.interval=DEFAULT_INTERVAL;
  this.failures=0;
  this.etag=undefined;
 }

 drainRead(){if(this.reading?.leased)return this.reading.task.catch(()=>{});}

 private clearTimer(){
  this.timer?.cancel();
  this.timer=undefined;
 }

 private jitter(interval:number){
  return Math.max(1,interval+Math.round((Math.random()*2-1)*2000));
 }

 private retry(minimum=0){
  this.failures=Math.min(5,this.failures+1);
  const delay=minimum>0?minimum:Math.min(MAX_BACKOFF,this.jitter(DEFAULT_INTERVAL*2**(this.failures-1)));
  this.headDue=this.ports.now()+delay;
 }

 private async tick(){
  if(this.running||this.unsupported||!this.ports.eligible())return;
  this.running=true;
  const revision=this.revision;
  const lifetime=new SyncV2Lifetime();
  const current=()=>revision===this.revision;
  const config=this.configDue<=this.ports.now();
  const expedited=this.expediteMemos;
  try{
   const task=Promise.resolve().then(()=>this.ports.read(config?'config':'head',lifetime));
   this.reading={leased:!config,lifetime,task};
   const result=await task;
   this.reading=undefined;
   if(!current()||!lifetime.isCurrent()||!this.ports.eligible())return;
   if(config){
    const value=result&&'enabled' in result?result:undefined;
    this.configDue=this.ports.now()+(value?.ttlMs??DEFAULT_CONFIG_TTL);
    if(value)this.enabled=value.enabled;
    if(!this.enabled&&!this.failures)this.headDue=undefined;
    return;
   }
   if(!result||!('status' in result)){
    this.headDue=this.ports.now()+this.jitter(this.interval);
    return;
   }
   const code=(result.status===400||result.status===403)?headErrorCode(result):undefined;
   if(result.status===404||result.status===405||code==='invalid_schema'&&result.status===400){
    this.unsupported=true;
    return;
   }
   if(result.status===403&&code==='head_poll_disabled'){
    this.enabled=false;
    this.headDue=undefined;
    this.etag=undefined;
    this.failures=0;
    return;
   }
   if(result.status===429){
    const retryAfter=header(result,'retry-after')?.trim();
    const minimum=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:retryAfter?Date.parse(retryAfter)-this.ports.now():0;
    let pollAfter=0;
    try{pollAfter=positiveMillis(json(result).pollAfterMs)??0;}catch{}
    this.retry(Math.max(Number.isSafeInteger(minimum)?minimum:0,pollAfter));
    return;
   }
   if(result.status!==304){
    if(result.status!==200)throw Error('head_request_failed');
    const data=json(result);
    if(typeof data.etag!=='string'||!data.etag||data.etag.length>512)throw Error('invalid_head_etag');
    this.interval=positiveMillis(data.pollAfterMs)??DEFAULT_INTERVAL;
    if(data.etag!==this.etag&&await this.ports.sync()&&current())this.etag=data.etag;
   }
   if(current()){
    this.failures=0;
    this.headDue=this.ports.now()+this.jitter(this.interval);
   }
  }catch{
   if(current()&&lifetime.isCurrent()){
    if(config)this.configDue=this.ports.now()+DEFAULT_CONFIG_TTL;
    else this.retry();
   }
  }finally{
   this.reading=undefined;
   this.running=false;
   if(current()&&this.expediteMemos!==expedited)this.ports.onPolicyChanged?.();
   this.update();
  }
 }
}
