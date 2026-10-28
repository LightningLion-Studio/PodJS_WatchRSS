import {decodeMediaText} from '../../media/text.ts';
import {query} from '../portable.ts';
import {type BiliFeedPage,type BiliPlayUrl,type BiliSession,type BiliTransport} from '../types.ts';
import {WATCH_COOLDOWN_MS,type BiliWatchConfig} from './config.ts';

export type WatchFallbackReason='disabled'|'unconfigured'|'logged_in_web'|'cooldown'|'transport'|'http'|'risk'|'api'|'parse'|'empty'|'quality'|'unsupported_params'|'direct_url';
export class WatchApiError extends Error {
  constructor(readonly reason:WatchFallbackReason){super('watch_api_'+reason);}
}
export interface WatchApiOptions {
  transport:BiliTransport;
  config:()=>BiliWatchConfig;
  session:()=>Promise<BiliSession|null>;
  parsePlay:(value:Record<string,any>)=>BiliPlayUrl;
  now:()=>number;
  cooldown?:{get():number;set(until:number):unknown};
  event?:(event:{operation:'feed'|'playurl';route:'watch'|'web';reason?:WatchFallbackReason;elapsedMs?:number})=>void;
}
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
const string=(v:unknown)=>typeof v==='string'?v:undefined;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const usableUrl=(url:unknown,now:number)=>{
  if(typeof url!=='string'||!/^https?:\/\/[^\s/]+\/[^\s]*$/.test(url)||url.length>16384)return false;
  const deadline=/[?&]deadline=(\d+)(?:&|$)/.exec(url);
  return !deadline||Number(deadline[1])*1000>now+30000;
};
/** One request per operation, fixed first-party hosts, bounded responses, no OAuth. */
export class BiliWatchApi {
  private cooldownUntil=0;
  constructor(private o:WatchApiOptions){}
  private config(){
    const c=this.o.config();
    if(c.biliWatchApi===false)throw new WatchApiError('disabled');
    if(this.o.now()<Math.max(this.cooldownUntil,this.o.cooldown?.get()??0))throw new WatchApiError('cooldown');
    if(![c.appkey,c.mobiApp,c.platform,c.device,c.build].every(v=>typeof v==='string'&&v.trim()&&v.length<=128&&!/[\r\n]/.test(v)))throw new WatchApiError('unconfigured');
    return c;
  }
  private async request(path:string,params:Record<string,any>){
    const c=this.config(),session=await this.o.session();
    // Cookie compatibility/entitlements require explicit verified configuration.
    if(session?.cookies.SESSDATA&&c.webCookieVerified!==true)throw new WatchApiError('logged_in_web');
    const headers:Record<string,string>={'Accept':'application/json','Referer':'https://www.bilibili.com/','User-Agent':'Mozilla/5.0'};
    if(session?.cookies.SESSDATA)headers.Cookie=Object.entries(session.cookies).map(([k,v])=>k+'='+v).join('; ');
    let r;
    try{r=await this.o.transport.request({method:'GET',url:'https://app.bilibili.com'+path+'?'+query({appkey:c.appkey,mobi_app:c.mobiApp,platform:c.platform,device:c.device,build:c.build,...params}),headers,timeoutMs:10000,acceptHttpErrors:true});}
    catch{throw new WatchApiError('transport');}
    const risk=()=>{
      this.cooldownUntil=this.o.now()+WATCH_COOLDOWN_MS;
      try{this.o.cooldown?.set(this.cooldownUntil);}catch{/* In-memory breaker remains active. */}
      throw new WatchApiError('risk');
    };
    if([403,412,429].includes(r.status))risk();
    if(r.body.byteLength>2*1024*1024)throw new WatchApiError('parse');
    let j:Record<string,any>={};
    try{const value=JSON.parse(await decodeMediaText(r.body,'bili'));if(!object(value))throw Error();j=value;}
    catch{if(![403,412,429].includes(r.status))throw new WatchApiError('parse');}
    if([-412,-352,-509].includes(Number(j.code)))risk();
    if(r.status<200||r.status>=300)throw new WatchApiError('http');
    if(j.code!==0)throw new WatchApiError('api');
    if(!object(j.data))throw new WatchApiError('parse');
    return {data:j.data,loggedIn:!!session?.cookies.SESSDATA};
  }
  async first<T>(operation:'feed'|'playurl',watch:()=>Promise<T>,web:()=>Promise<T>):Promise<T>{
    const started=this.o.now();
    try{const value=await watch();this.emit({operation,route:'watch',elapsedMs:this.o.now()-started});return value;}
    catch(error){
      const reason=error instanceof WatchApiError?error.reason:'parse';
      this.emit({operation,route:'web',reason,elapsedMs:this.o.now()-started});
      return web();
    }
  }
  private emit(event:Parameters<NonNullable<WatchApiOptions['event']>>[0]){try{this.o.event?.(event);}catch{/* Metrics never break playback. */}}
  async feed(params:Record<string,string|number>={}):Promise<BiliFeedPage>{
    if(Object.keys(params).some(k=>!['page_next','pn','ps'].includes(k)))throw new WatchApiError('unsupported_params');
    const page=params.page_next;
    if(page!==undefined&&(typeof page!=='string'||page.length>4096))throw new WatchApiError('unsupported_params');
    let cursor:Record<string,any>={pn:Math.max(1,Math.floor(Number(params.pn)||1)),ps:Math.max(1,Math.min(20,Math.floor(Number(params.ps)||20)))};
    if(typeof page==='string'){
      try{const parsed=JSON.parse(page);if(!object(parsed))throw Error();cursor={...parsed,ps:Math.max(1,Math.min(20,Math.floor(Number(parsed.ps)||20)))};}catch{throw new WatchApiError('unsupported_params');}
    }
    const {data}=await this.request('/x/watch/feed',{page_next:JSON.stringify(cursor)});
    if(!Array.isArray(data.items))throw new WatchApiError('parse');
    const items=data.items.slice(0,20).filter(v=>object(v)&&v.item_type==='ugc'&&Number.isSafeInteger(v.aid)&&v.aid>0&&Number.isSafeInteger(v.cid)&&v.cid>0).map(v=>({aid:number(v.aid),cid:number(v.cid),bvid:string(v.bvid),title:string(v.title),cover:string(v.cover),duration:number(v.duration),owner:object(v.author)?{mid:number(v.author.mid),name:string(v.author.name),face:string(v.author.face)}:undefined}));
    if(data.items.length&&!items.length)throw new WatchApiError('empty');
    const next=typeof data.page_next==='string'?data.page_next:object(data.page_next)?JSON.stringify(data.page_next):undefined;
    return {items,source:'watch',nextPage:next&&next.length<=4096?next:undefined};
  }
  async play(x:{cid:number;aid?:number;bvid?:string;qn?:number;preferMp4?:boolean}):Promise<BiliPlayUrl>{
    if(!Number.isSafeInteger(x.aid)||x.aid!<=0||!Number.isSafeInteger(x.cid)||x.cid<=0)throw new WatchApiError('unsupported_params');
    const qn=x.qn??(x.preferMp4?32:64);
    const {data,loggedIn}=await this.request('/x/watch/player/playurl',{aid:x.aid,cid:x.cid,qn,fnval:x.preferMp4?1:4048,resume:1});
    let source:BiliPlayUrl;
    try{source=this.o.parsePlay(data);}catch{throw new WatchApiError('parse');}
    if(source.durl.length&&data.video_codecid!=null&&data.video_codecid!==7)throw new WatchApiError('empty');
    const now=this.o.now();
    source.durl=source.durl.slice(0,8).map(v=>({...v,url:usableUrl(v.url,now)?v.url:undefined,backupUrl:v.backupUrl.filter(u=>usableUrl(u,now)).slice(0,8)}));
    if(source.dash){
      const filter=(tracks:NonNullable<BiliPlayUrl['dash']>['video'])=>tracks.slice(0,16).map(v=>({...v,baseUrl:usableUrl(v.baseUrl,now)?v.baseUrl:undefined,backupUrl:v.backupUrl.filter(u=>usableUrl(u,now)).slice(0,8)}));
      source.dash={video:filter(source.dash.video).filter(v=>v.codecId==null||v.codecId===7),audio:filter(source.dash.audio)};
    }
    const usable=source.durl.length?!!(source.durl[0]?.url||source.durl[0]?.backupUrl.length):!!source.dash?.video.some(v=>v.baseUrl||v.backupUrl.length);
    if(!usable)throw new WatchApiError('empty');
    if(loggedIn&&(source.quality??0)<qn)throw new WatchApiError('quality');
    return {...source,apiSource:'watch'};
  }
}
