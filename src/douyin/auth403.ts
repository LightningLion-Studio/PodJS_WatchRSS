import * as hostServices from '@podjs/framework/services';
import type {DouyinSecureStorage} from './types.ts';

export const DOUYIN_AUTH403_CONFIG_KEY='watchrss.douyin.auth403.v1';
export const DOUYIN_AUTH403_COOLDOWN_KEY='douyin.auth403.cooldown.v1';
export const DOUYIN_AUTH403_MAX_COOLDOWN_MS=15*60*1000;
export type DouyinLoginProbeResult='authenticated'|'unauthenticated'|'unknown';
export interface DouyinLoginProbeOperation {result:Promise<DouyinLoginProbeResult>;cancel():void}
export type DouyinApiCategory='feed'|'detail'|'other';
export type Douyin403Metric={stage:'forbidden'|'resign'|'probe'|'cooldown'|'storage';api:DouyinApiCategory;count:1;result?:'authenticated'|'unauthenticated'|'unknown'|'timeout'|'cancelled'|'failed'|'active'|'entered';delayMs?:number};
export interface Douyin403Options {
  /** Default on; explicit false restores the former immediate-expiry behavior. */
  enabled?:boolean|(()=>boolean);
  /** Supply only an independently verified account-state contract. No endpoint is guessed here. */
  probe?:(context:Readonly<{cookie:string;timeoutMs:number}>)=>Promise<DouyinLoginProbeResult>|DouyinLoginProbeOperation;
  sleep?:(ms:number)=>Promise<unknown>;
  timer?:(ms:number)=>{result:Promise<unknown>;cancel():void};
  random?:()=>number;
}
export function readDouyin403Enabled(store:{get<T>(key:string):T|undefined|null}):boolean {
  try{return store.get<{enabled?:boolean}>(DOUYIN_AUTH403_CONFIG_KEY)?.enabled!==false;}catch{return true;}
}
type Cooldown={until:number;strikes:number;authenticated:boolean};
export type Douyin403Decision={kind:'unauthenticated'}|{kind:'cancelled'}|{kind:'limited';authenticated:boolean;retryAfterMs:number};
/** A single cookie generation owns this instance. The client serializes durable writes. */
export class Douyin403Policy {
  private state:Cooldown={until:0,strikes:0,authenticated:false};
  private loaded?:Promise<void>;
  private decision?:Promise<Douyin403Decision>;
  private version=0;
  constructor(private ports:{storage:DouyinSecureStorage;now:()=>number;options:Douyin403Options;current:()=>Promise<boolean>;metric:(value:Douyin403Metric)=>void}){}
  private async load(){
    return this.loaded??=(async()=>{
      try{
        const raw=await this.ports.storage.get(DOUYIN_AUTH403_COOLDOWN_KEY);if(!raw)return;
        if(raw.length>512)throw Error('invalid_cooldown_state');
        const v=JSON.parse(raw);
        if(v?.version===1&&Number.isSafeInteger(v.until)&&v.until>=0&&Number.isInteger(v.strikes)&&v.strikes>=0&&v.strikes<=6&&typeof v.authenticated==='boolean')
          this.state={until:Math.min(v.until,this.ports.now()+DOUYIN_AUTH403_MAX_COOLDOWN_MS),strikes:v.strikes,authenticated:v.authenticated};
      }catch{this.ports.metric({stage:'storage',api:'other',count:1,result:'failed'});}
    })();
  }
  snapshotVersion(){return this.version;}
  async cooldown(api:DouyinApiCategory):Promise<Douyin403Decision|undefined>{
    await this.load();
    return this.activeCooldown(api);
  }
  activeCooldown(api:DouyinApiCategory):Extract<Douyin403Decision,{kind:'limited'}>|undefined {
    const retryAfterMs=Math.max(0,this.state.until-this.ports.now());
    if(!retryAfterMs)return;
    this.ports.metric({stage:'cooldown',api,count:1,result:'active'});
    return {kind:'limited',authenticated:this.state.authenticated,retryAfterMs};
  }
  async successful(version:number){
    await this.load();if(version!==this.version||!this.state.strikes||!await this.ports.current()||version!==this.version)return;
    this.version++;this.state={until:0,strikes:0,authenticated:false};
    try{await this.ports.storage.remove(DOUYIN_AUTH403_COOLDOWN_KEY);}catch{this.ports.metric({stage:'storage',api:'other',count:1,result:'failed'});}
  }
  async backoff(api:DouyinApiCategory){
    const random=(this.ports.options.random??Math.random)();
    const delayMs=500+Math.floor(Math.max(0,Math.min(1,Number.isFinite(random)?random:.5))*1000);
    this.ports.metric({stage:'resign',api,count:1,delayMs});
    await (this.ports.options.sleep??(ms=>hostServices.delay(ms).result))(delayMs);
  }
  async resolve(cookie:string,api:DouyinApiCategory):Promise<Douyin403Decision>{
    await this.load();
    if(!await this.ports.current())return {kind:'cancelled'};
    const active=this.activeCooldown(api);if(active)return active;
    if(!this.decision)this.decision=this.decide(cookie,api).finally(()=>{this.decision=undefined;});
    return this.decision;
  }
  /** An HTML detail challenge is not evidence of an expired login. */
  async challenge(api:DouyinApiCategory):Promise<Douyin403Decision>{
    await this.load();if(!await this.ports.current())return {kind:'cancelled'};
    return this.activeCooldown(api)??this.enterCooldown(api,false);
  }
  private async decide(cookie:string,api:DouyinApiCategory):Promise<Douyin403Decision>{
    let result:DouyinLoginProbeResult='unknown',timedOut=false;
    const probe=this.ports.options.probe;
    if(probe){
      const timer=(this.ports.options.timer??(ms=>hostServices.delay(ms)))(5000);
      let operation:DouyinLoginProbeOperation|undefined;
      try{
        const requested=probe({cookie,timeoutMs:5000});
        operation=requested&&'result' in requested?requested:undefined;
        const pending=operation?operation.result:requested as Promise<DouyinLoginProbeResult>;
        const value=await Promise.race([pending,timer.result.then(()=> 'timeout' as const)]);
        if(value==='timeout')timedOut=true;
        else if(value==='authenticated'||value==='unauthenticated')result=value;
      }catch{result='unknown';}
      finally{timer.cancel();try{operation?.cancel();}catch{}}
    }
    if(!await this.ports.current())return {kind:'cancelled'};
    this.ports.metric({stage:'probe',api,count:1,result:timedOut?'timeout':result});
    if(result==='unauthenticated')return {kind:'unauthenticated'};
    return this.activeCooldown(api)??this.enterCooldown(api,result==='authenticated');
  }
  private async enterCooldown(api:DouyinApiCategory,authenticated:boolean):Promise<Douyin403Decision>{
    const strikes=Math.min(6,this.state.strikes+1),delayMs=Math.min(DOUYIN_AUTH403_MAX_COOLDOWN_MS,30_000*2**(strikes-1));
    this.version++;this.state={until:this.ports.now()+delayMs,strikes,authenticated};
    try{await this.ports.storage.set(DOUYIN_AUTH403_COOLDOWN_KEY,JSON.stringify({version:1,...this.state}));}
    catch{this.ports.metric({stage:'storage',api,count:1,result:'failed'});}
    if(!await this.ports.current())return {kind:'cancelled'};
    this.ports.metric({stage:'cooldown',api,count:1,result:'entered',delayMs});
    return {kind:'limited',authenticated:this.state.authenticated,retryAfterMs:Math.max(0,this.state.until-this.ports.now())};
  }
}
