import {douyinBench} from './bench.ts';
import {douyinMediaExpiry} from './media-expiry.ts';
import {rememberRecommendationIds} from '../media/recommendation-history.ts';
import {douyinRequestProfile,resolveDouyinRequestConfig,DOUYIN_USER_AGENT,DOUYIN_REFERER,type DouyinRequestConfig} from './request-config.ts';
import {douyinFeedSeenKey,readDouyinSeenIds,filterDouyinRecommendations} from './recommendations.ts';
import {Douyin403Policy,DOUYIN_AUTH403_COOLDOWN_KEY,type DouyinApiCategory,type Douyin403Decision,type Douyin403Metric} from './auth403.ts';
import {boundedVideoPageSize} from '../media/traffic-policy.ts';
import {decodableDouyinItem,videoOptEnabled,VideoPlaybackTrace,registerVideoResolution} from '../media/video-opt.ts';
import {DouyinHistoryStore} from './history-store.ts';
import {applyPreferredDouyinPlayback,normalizedDouyinResolution} from './playback-selector.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {logPlatformId} from '../logs/fields.ts';
import {appLogger} from '../logs/app-logger.ts';
import {formatDouyinError,mediaRequestFailure,isDouyinTemporaryFailure} from './errors.ts';
import { DouyinFeedStore, FEED_KEY, RECENT_KEY, QUEUE_KEY, normalizeItems } from "./feed-store.ts";
import {decodeMediaText} from '../media/text.ts';
import { parseDouyinDetail, parseDouyinFeedAsync, readDouyinStatusCode, isDouyinHtmlChallenge } from "./parser.ts";
import { ABogusSigner } from "./signing.ts";
import { DouyinSavedStore } from "./saved.ts";
import type { DouyinClientOptions, DouyinErrorCode, DouyinContent, DouyinFeedPage, DouyinHistoryEntry, DouyinInteraction, DouyinItem, DouyinResult, DouyinSavedKind, DouyinSigner } from "./types.ts";

export {DOUYIN_USER_AGENT,DOUYIN_REFERER};
export const DOUYIN_PUBLIC_MEDIA_HEADERS:Readonly<Record<string,string>>=Object.freeze({"User-Agent":DOUYIN_USER_AGENT,Referer:DOUYIN_REFERER});
const COOKIE_KEY="douyin.cookie";
export const DOUYIN_DETAIL_WINDOW_MS=10_000;
export const DOUYIN_DETAIL_MAX_REQUESTS=4;
const FEED_CACHE_LIMIT=60;
// DouyinWebCrawler uses OkHttp defaults: 10s connect/read/write, no call timeout.
export const DOUYIN_NETWORK_TIMEOUT_MS=10_000;
const query=(p:Record<string,string>)=>Object.keys(p).map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join("&");
const fail=<T>(code:DouyinErrorCode,message:string):Extract<DouyinResult<T>,{ok:false}>=>({ok:false,code,message});
export type DouyinAuthState='unknown'|'logged-in'|'logged-out';
export class DouyinClient {
  private authentication:DouyinAuthState='unknown';
  private readonly authListeners=new Set<(state:DouyinAuthState)=>void>();
  authState():DouyinAuthState{return this.authentication;}
  subscribeAuth(listener:(state:DouyinAuthState)=>void){this.authListeners.add(listener);return ()=>{this.authListeners.delete(listener);};}
  private setAuth(state:DouyinAuthState){this.authentication=state;for(const listener of this.authListeners)listener(state);}
  private cookieRead?:{generation:number;result:Promise<string|null>};
  private readonly authExpiredListeners=new Set<()=>void>();
  onAuthExpired(listener:()=>void){this.authExpiredListeners.add(listener);return ()=>{this.authExpiredListeners.delete(listener);};}
  private authGeneration=0;
  private cookieApplication?:{generation:number;result:Promise<DouyinResult<void>>};
  private cookieWrites:Promise<unknown>=Promise.resolve();
  private policy?:{generation:number;cookie:string;value:Douyin403Policy};
  private readonly forbiddenRequests=new Map<string,Promise<DouyinResult<string>>>();
  private expiry?:{generation:number;result:Promise<DouyinResult<never>>};
  private enqueueCookie<T>(work:()=>Promise<T>):Promise<T>{const next=this.cookieWrites.catch(()=>{}).then(work);this.cookieWrites=next;return next;}
  private async currentAuth(cookie:string,generation:number){return generation===this.authGeneration&&await this.readCookie()===cookie&&generation===this.authGeneration;}
  private metric(value:Douyin403Metric){appLogger.i('Douyin403',JSON.stringify(value));}
  private recoveryEnabled(){try{const enabled=this.options.auth403?.enabled;return (typeof enabled==='function'?enabled():enabled)!==false;}catch{return true;}}
  private recoveryPolicy(cookie:string,generation:number){
    if(this.policy?.generation===generation&&this.policy.cookie===cookie)return this.policy.value;
    const current=()=>this.currentAuth(cookie,generation),storage=this.options.secureStorage;
    const value=new Douyin403Policy({now:this.now,options:this.options.auth403??{},current,metric:event=>this.metric(event),storage:{
      get:key=>storage.get(key),
      set:(key,value)=>this.enqueueCookie(async()=>{if(await current())await storage.set(key,value);}),
      remove:key=>this.enqueueCookie(async()=>{if(await current())await storage.remove(key);}),
    }});
    this.policy={generation,cookie,value};return value;
  }
  private async expireAuthentication(cookie:string,generation:number):Promise<DouyinResult<never>>{
    if(this.expiry?.generation===generation)return this.expiry.result;
    const result=(async()=>{
      if(!await this.currentAuth(cookie,generation))return fail<never>('CANCELLED',formatDouyinError('CANCELLED'));
      await this.clearCookie();
      if(this.authGeneration!==generation+1)return fail<never>('CANCELLED',formatDouyinError('CANCELLED'));
      for(const listener of this.authExpiredListeners)listener();
      return fail<never>('NOT_LOGGED_IN','登录已失效，请重新登录');
    })().catch(()=>{this.metric({stage:'storage',api:'other',count:1,result:'failed'});return fail<never>('REQUEST_FAILED',formatDouyinError('REQUEST_FAILED'));});
    this.expiry={generation,result};
    try{return await result;}finally{if(this.expiry?.result===result)this.expiry=undefined;}
  }
  private async authDecision(policy:Douyin403Policy,cookie:string,generation:number,api:DouyinApiCategory):Promise<DouyinResult<never>>{
    const decision=await policy.resolve(cookie,api);
    if(!await this.currentAuth(cookie,generation)||decision.kind==='cancelled')return fail('CANCELLED',formatDouyinError('CANCELLED'));
    if(decision.kind==='unauthenticated')return this.expireAuthentication(cookie,generation);
    return this.limited(decision);
  }
  private limited(decision:Extract<Douyin403Decision,{kind:'limited'}>):DouyinResult<never>{
    const code=decision.authenticated?'RATE_LIMITED':'TEMPORARILY_UNAVAILABLE';
    return {...fail<never>(code,formatDouyinError(code)),retryAfterMs:decision.retryAfterMs};
  }
  private readonly now:()=>number;
  private readonly signer:DouyinSigner;
  private readonly saved:NonNullable<DouyinClientOptions["savedStore"]>;
  private readonly detailRequests=new Map<string,Promise<DouyinResult<DouyinContent>>>();
  private readonly feedRequests=new Map<string,Promise<DouyinResult<DouyinFeedPage>>>();
  private detailTimes:number[]=[];
  private readonly prefetchFailures=new Map<string,{result:Extract<DouyinResult<DouyinItem>,{ok:false}>;until:number}>();
  private readonly playbackResolutions=new Map<string,Promise<DouyinResult<DouyinItem>>>();
  private readonly feedCache=new Map<string,{item:DouyinItem;resolvedAtMillis:number}>();
  private readonly feedStore:DouyinFeedStore;
  private feedCursor:string|null=null;
  private feedHasMore=false;
  private readonly history:DouyinHistoryStore;

  constructor(private readonly options:DouyinClientOptions){this.feedStore=new DouyinFeedStore(options.historyStorage??options.secureStorage);this.history=new DouyinHistoryStore(options.historyStorage??options.secureStorage);this.now=options.now??Date.now;this.signer=options.signer??new ABogusSigner();this.saved=options.savedStore??new DouyinSavedStore(options.savedStorage??options.historyStorage??options.secureStorage,this.now);}
  async readCookie():Promise<string|null>{
    // A deliberate logout is authoritative in this guest, including failed cleanup.
    if(this.authentication==='logged-out')return null;
    const generation=this.authGeneration;
    if(this.cookieApplication?.generation===generation){await this.cookieApplication.result;return this.readCookie();}
    if(this.cookieRead?.generation===generation)return this.cookieRead.result;
    const result=(async()=>{
      const raw=await traceServiceWork("douyin.cookie.request",()=>this.options.secureStorage.get(COOKIE_KEY));
      if(generation!==this.authGeneration)return null;
      const value=traceServiceWork("douyin.cookie.result",()=>raw?.trim()||null,raw?.length??0);
      this.setAuth(value?'logged-in':'logged-out');return value;
    })();
    this.cookieRead={generation,result};
    try{return await result;}finally{if(this.cookieRead?.result===result)this.cookieRead=undefined;}
  }
  async isLoggedIn(){return this.authentication==='unknown'?(await this.readCookie())!==null:this.authentication==='logged-in';}
  private clearFeedCache(){this.detailRequests.clear();this.feedRequests.clear();this.prefetchFailures.clear();this.detailTimes=[];this.playbackResolutions.clear();this.feedCache.clear();this.feedCursor=null;this.feedHasMore=false;}
  async applyCookie(raw:string,commitCookie:(value:string)=>Promise<void>=value=>this.options.secureStorage.set(COOKIE_KEY,value)){
    const value=raw.trim();if(!value)return fail<void>('NOT_LOGGED_IN','缺少有效 Cookie');
    const benchAttempt=douyinBench.attempt(this);
    const generation=++this.authGeneration;this.policy=undefined;this.forbiddenRequests.clear();this.clearFeedCache();
    const result=this.enqueueCookie(async()=>{await commitCookie(value);await this.options.secureStorage.remove(DOUYIN_AUTH403_COOLDOWN_KEY);await this.feedStore.clear();if(generation===this.authGeneration){this.cookieApplication=undefined;this.setAuth('logged-in');if(benchAttempt)douyinBench.persisted(this,benchAttempt);}return {ok:true,data:undefined} as DouyinResult<void>;});
    this.cookieApplication={generation,result};this.setAuth('unknown');
    try{return await result;}finally{if(this.cookieApplication?.result===result)this.cookieApplication=undefined;}
  }
  async clearCookie(commitCookie?:()=>Promise<void>,cleanup?:()=>Promise<void>){
    const observation=douyinBench.authClear(this);
    const commit=commitCookie??(()=>this.options.secureStorage.remove(COOKIE_KEY,observation));
    this.authGeneration++;this.setAuth('logged-out');this.policy=undefined;this.forbiddenRequests.clear();this.clearFeedCache();
    // Submit browser cleanup now, before a new login can submit browser authorization.
    // Keep its completion in the write chain so it cannot erase a newly applied Cookie.
    const extra=Promise.resolve().then(()=>cleanup?.()).then(()=>({status:'fulfilled',value:undefined} as const),reason=>({status:'rejected',reason} as const));
    await this.enqueueCookie(async()=>{
      const results=await Promise.allSettled([(async()=>{await commit();await this.options.secureStorage.remove(DOUYIN_AUTH403_COOLDOWN_KEY);await this.feedStore.clear();})()]);
      results.push(await extra);
      const failure=results.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    });
  }
  logout(){return this.clearCookie(undefined,this.options.onLogout);}
  async buildPlaybackHeaders():Promise<Record<string,string>>{const cookie=await this.readCookie(),profile=douyinRequestProfile(await resolveDouyinRequestConfig(this.options.requestConfig));return {...profile.headers,...(cookie?{Cookie:cookie}:{})};}
  private async get(path:string,params:Record<string,string>,method:'GET'|'POST',config?:DouyinRequestConfig):Promise<DouyinResult<string>> {
    await this.cookieWrites.catch(()=>{});
    const generation=this.authGeneration,cookie=await this.readCookie();
    if(generation!==this.authGeneration)return fail('CANCELLED',formatDouyinError('CANCELLED'));
    if(!cookie)return fail('NOT_LOGGED_IN','未登录');
    const profile=douyinRequestProfile(config??await resolveDouyinRequestConfig(this.options.requestConfig));params={...profile.params,...params};
    const api:DouyinApiCategory=path==='/aweme/v2/web/module/feed/'?'feed':path==='/aweme/v1/web/aweme/detail/'?'detail':'other';
    const policy=this.recoveryPolicy(cookie,generation);
    if(policy){const limited=await policy.cooldown(api);if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));if(limited?.kind==='limited')return this.limited(limited);}
    const policyVersion=policy.snapshotVersion(api);
    const attempt=async():Promise<DouyinResult<string>|{forbidden:true}>=>{
      if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
      let signed:string;
      try{signed=await this.signer.sign({...params});}
      catch{appLogger.e('DouyinClient',`request failed path=${path} category=signing`);return fail('REQUEST_FAILED',formatDouyinError('REQUEST_FAILED'));}
      if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
      const active=policy?.activeCooldown(api);if(active)return this.limited(active);
      if(api==='detail'){
        this.detailTimes=this.detailTimes.filter(time=>time>this.now()-DOUYIN_DETAIL_WINDOW_MS);
        if(this.detailTimes.length>=DOUYIN_DETAIL_MAX_REQUESTS)return {...fail<string>('TEMPORARILY_UNAVAILABLE',formatDouyinError('TEMPORARILY_UNAVAILABLE')),retryAfterMs:Math.max(1,this.detailTimes[0]+DOUYIN_DETAIL_WINDOW_MS-this.now())};
        this.detailTimes.push(this.now());
      }
      const url=`https://www.douyin.com${path}?${query({...params,a_bogus:signed})}`;
      try{
        if(api==='detail')appLogger.i('DouyinDetail',JSON.stringify({event:'request',api:'detail',count:1,mode:'abogus_only'}));
        const r=await this.options.transport.request({method,url,headers:{...profile.headers,Cookie:cookie,Accept:'application/json',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}:{})},
          timeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,readTimeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,acceptHttpErrors:true,...(method==='POST'?{body:new Uint8Array(0)}:{})});
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        appLogger.d('DouyinClient',`response path=${path} status=${r.status}`);
        const detailBody=await decodeMediaText(r.body);
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        if(isDouyinHtmlChallenge(detailBody)){
          appLogger.w('DouyinDetail',JSON.stringify({event:'challenge',api:'detail',count:1,mode:'abogus_only'}));
          const decision=await policy?.challenge(api);
          if(!await this.currentAuth(cookie,generation)||decision?.kind==='cancelled')return fail('CANCELLED',formatDouyinError('CANCELLED'));
          return {...fail('TEMPORARILY_UNAVAILABLE',formatDouyinError('TEMPORARILY_UNAVAILABLE')),retryAfterMs:decision?.kind==='limited'?decision.retryAfterMs:30000};
        }
        if(r.status===403){appLogger.e('DouyinClient',`request failed path=${path} category=http status=403`);this.metric({stage:'forbidden',api,count:1});return {forbidden:true};}
        if(r.status!==200){appLogger.e('DouyinClient',`request failed path=${path} category=http status=${r.status}`);return fail('REQUEST_FAILED',`请求失败，状态码：${r.status}（仅支持200）`);}
        const body=detailBody??await decodeMediaText(r.body);
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        if(!body.trim()||body==='blocked'){
          appLogger.w('DouyinClient',`request failed path=${path} category=authentication reason=${body==='blocked'?'blocked':'empty'}`);
          return this.authDecision(policy,cookie,generation,api);
        }
        const statusCode=await readDouyinStatusCode(body);
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        if(statusCode===8){appLogger.w('DouyinClient',`request failed path=${path} category=authentication reason=status8`);return this.expireAuthentication(cookie,generation);}
        if(statusCode!==undefined&&statusCode!==0)return fail('REQUEST_FAILED',formatDouyinError('REQUEST_FAILED'));
        await policy.successful(policyVersion,api);
        return await this.currentAuth(cookie,generation)?{ok:true,data:body}:fail('CANCELLED',formatDouyinError('CANCELLED'));
      }catch(error){
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        const failure=mediaRequestFailure(error);
        if(failure.status===403){appLogger.e('DouyinClient',`request failed path=${path} category=${failure.category} status=403`);this.metric({stage:'forbidden',api,count:1});return {forbidden:true};}
        appLogger.e('DouyinClient',`request failed path=${path} category=${failure.category}${failure.status===undefined?'':` status=${failure.status}`}`);
        return fail(failure.category==='cancelled'?'CANCELLED':'REQUEST_FAILED',failure.status===undefined?formatDouyinError('REQUEST_FAILED'):`请求失败，状态码：${failure.status}（仅支持200）`);
      }
    };
    const first=await attempt();if(!('forbidden' in first))return first;
    if(!this.recoveryEnabled())return this.authDecision(policy,cookie,generation,api);
    const key=JSON.stringify([generation,method,path,params]),existing=this.forbiddenRequests.get(key);if(existing)return existing;
    if(this.forbiddenRequests.size>=4)return {...fail<string>('TEMPORARILY_UNAVAILABLE',formatDouyinError('TEMPORARILY_UNAVAILABLE')),retryAfterMs:1500};
    const pending=(async():Promise<DouyinResult<string>>=>{
      try{await policy.backoff(api);}catch{return fail('CANCELLED',formatDouyinError('CANCELLED'));}
      if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
      const limited=await policy.cooldown(api);if(limited?.kind==='limited')return this.limited(limited);
      const retried=await attempt();
      if('forbidden' in retried)return this.authDecision(policy,cookie,generation,api);
      if(!retried.ok&&retried.code==='NOT_LOGGED_IN')return this.expireAuthentication(cookie,generation);
      return retried;
    })();
    this.forbiddenRequests.set(key,pending);
    try{return await pending;}finally{if(this.forbiddenRequests.get(key)===pending)this.forbiddenRequests.delete(key);}
  }
  private cachePrefetchFailure(id:string,result:Extract<DouyinResult<DouyinItem>,{ok:false}>){
    if(result.code==='CANCELLED')return;
    this.prefetchFailures.delete(id);this.prefetchFailures.set(id,{result,until:isDouyinTemporaryFailure(result.code)?this.now()+(result.retryAfterMs??30000):Infinity});
    while(this.prefetchFailures.size>60)this.prefetchFailures.delete(this.prefetchFailures.keys().next().value!);
  }
  private cacheItem(item:DouyinItem,resolvedAtMillis:number){
    this.feedCache.delete(item.awemeId);this.feedCache.set(item.awemeId,{item,resolvedAtMillis});
    while(this.feedCache.size>FEED_CACHE_LIMIT)this.feedCache.delete(this.feedCache.keys().next().value!);
  }
  private freshFeedItem(awemeId:string):DouyinItem|null{
    const cached=this.feedCache.get(awemeId);if(!cached)return null;
    if(this.now()>=douyinMediaExpiry(cached.item.playUrl,cached.resolvedAtMillis)){this.feedCache.delete(awemeId);return null;}
    this.feedCache.delete(awemeId);this.feedCache.set(awemeId,cached);return cached.item;
  }
  async fetchFeedPage(input:{cursor?:string|null;count?:number}={}):Promise<DouyinResult<DouyinFeedPage>>{
    const key=JSON.stringify([this.authGeneration,input.cursor?.trim()||null,input.count??10]);
    let pending=this.feedRequests.get(key);if(!pending){pending=this.fetchFeedPageInner(input);this.feedRequests.set(key,pending);}
    try{return await pending;}finally{if(this.feedRequests.get(key)===pending)this.feedRequests.delete(key);}
  }
  private async fetchFeedPageInner(input:{cursor?:string|null;count?:number}={}):Promise<DouyinResult<DouyinFeedPage>> {
    const generation=this.authGeneration;await this.prepareHistory();
    const cookie=await this.readCookie(),config=await resolveDouyinRequestConfig(this.options.requestConfig);
    if(generation!==this.authGeneration)return fail('CANCELLED',formatDouyinError('CANCELLED'));
    const count=Math.max(1,Math.min(20,boundedVideoPageSize(input.count,videoOptEnabled('traffic'),10))),cursor=input.cursor?.trim()||null;
    const storage=this.options.historyStorage??this.options.secureStorage,key=cookie?douyinFeedSeenKey(cookie):'';
    let params:Record<string,string>={count:String(count)},web:ReturnType<NonNullable<DouyinClientOptions['webFeedPagination']>>|undefined;
    if(config.webPagination&&this.options.webFeedPagination){
      web=this.options.webFeedPagination({cursor,count,presentedIds:await readDouyinSeenIds(storage,key)});params={...web.params,count:String(count)};
    }else{
      if(config.webPagination)appLogger.w('DouyinFeed','pagination contract=unconfigured mode=legacy');
      if(cursor){params.cursor=cursor;params.max_cursor=cursor;}
    }
    if(generation!==this.authGeneration)return fail('CANCELLED',formatDouyinError('CANCELLED'));
    const r=await this.get('/aweme/v2/web/module/feed/',params,'POST',config);if(!r.ok)return r;
    try{
      const parsed=await parseDouyinFeedAsync(r.data),resolvedAtMillis=this.now();
      if(web)parsed.nextCursor=web.nextCursor(parsed);
      return await this.enqueueCookie(async():Promise<DouyinResult<DouyinFeedPage>>=>{
        if(!cookie||!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        const previous=await readDouyinSeenIds(storage,key);
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        const filtered=filterDouyinRecommendations(parsed.items,previous);
        // Empty/duplicate pages keep the server continuation; the queue bounds refill work.
        const data={...parsed,items:filtered.items};
        await this.feedStore.save(FEED_KEY,{items:data.items.slice(0,20),cursor:data.nextCursor,hasMore:data.hasMore,anchorAwemeId:null,savedAtMillis:resolvedAtMillis,resolved:Object.fromEntries(data.items.map(item=>[item.awemeId,resolvedAtMillis]))});
        if(!await this.currentAuth(cookie,generation))return fail('CANCELLED',formatDouyinError('CANCELLED'));
        for(const item of data.items)this.cacheItem(item,resolvedAtMillis);
        this.feedCursor=data.nextCursor;this.feedHasMore=data.hasMore;
        appLogger.i('DouyinFeed',JSON.stringify({filteredCount:filtered.filteredCount}));
        return {ok:true,data,source:'network'};
      });
    }catch{appLogger.e('DouyinClient','feed failed category=parse_or_cache');return fail('PARSE_FAILED',formatDouyinError('PARSE_FAILED'));}
  }
  feedSnapshot(){const items:DouyinItem[]=[];for(const id of [...this.feedCache.keys()]){const item=this.freshFeedItem(id);if(item)items.push(item);}return {items:items.slice(-40),cursor:this.feedCursor,hasMore:this.feedHasMore};}
  async fetchDetail(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinContent>>{
    const id=awemeId.trim();if(!id)return fail('PARSE_FAILED','缺少 awemeId');
    const pending=this.detailRequests.get(id);if(pending)return pending;
    const cached=this.freshFeedItem(id);if(cached&&!options.forceRefresh)return {ok:true,data:{kind:'video',item:cached},source:'feed-cache'};
    const generation=this.authGeneration;
    const work=(async():Promise<DouyinResult<DouyinContent>>=>{
      const r=await this.get('/aweme/v1/web/aweme/detail/',{aweme_id:id},'GET');
      if(!r.ok&&r.code==='NOT_LOGGED_IN')return r;
      if(generation!==this.authGeneration)return fail('CANCELLED',formatDouyinError('CANCELLED'));
      if(!r.ok)return r;
      try{const data=traceServiceWork('douyin.detail.parse',()=>parseDouyinDetail(r.data));if(data.kind==='video')this.cacheItem(data.item,this.now());return {ok:true,data,source:'network'};}
      catch{return fail('PARSE_FAILED',formatDouyinError('PARSE_FAILED'));}
    })();this.detailRequests.set(id,work);
    try{return await work;}finally{if(this.detailRequests.get(id)===work)this.detailRequests.delete(id);}
  }
  private async resolvePlaybackInner(awemeId:string,options:{forceRefresh?:boolean;prefetch?:boolean}={}):Promise<DouyinResult<DouyinItem>>{
    const id=awemeId.trim();
    const failure=this.prefetchFailures.get(id);if(options.prefetch&&failure&&failure.until>this.now())return failure.result;
    const cached=this.freshFeedItem(id);if(cached&&!options.forceRefresh)return {ok:true,data:cached,source:'feed-cache'};
    const r=await this.fetchDetail(id,options);
    return !r.ok?r:r.data.kind==='video'?{ok:true,data:r.data.item,source:r.source}:fail('UNSUPPORTED','此内容没有视频播放流');
  }
  async resolvePlayback(awemeId:string,options:{forceRefresh?:boolean;prefetch?:boolean}={}):Promise<DouyinResult<DouyinItem>>{
    const start=Date.now(),id=awemeId.trim(),key=JSON.stringify([id,options.forceRefresh===true]);let pending=this.playbackResolutions.get(key);if(!pending){pending=this.resolvePlaybackInner(id,options);this.playbackResolutions.set(key,pending);}let result:DouyinResult<DouyinItem>;try{result=await pending;}finally{if(this.playbackResolutions.get(key)===pending)this.playbackResolutions.delete(key);}
    if(result.ok){const item=await decodableDouyinItem(applyPreferredDouyinPlayback(result.data));if(!item.playUrl.trim()){const unavailable=fail<DouyinItem>('UNSUPPORTED','没有可用的视频播放流');if(options.prefetch)this.cachePrefetchFailure(id,unavailable);return unavailable;}const v=item.variants?.find(v=>v.playUrl===item.playUrl);const trace=new VideoPlaybackTrace('douyin',start);trace.event('api',{apiMs:Date.now()-start,cacheHit:result.source==='feed-cache'?1:0});trace.event('candidate',{width:v?.width,height:v?.height,bitrate:v?.bitrate});for(const url of [item.playUrl,...(item.variants?.find(v=>v.playUrl===item.playUrl)?.playUrls??[]).slice(0,8)])registerVideoResolution(url,trace);appLogger.i('DouyinTiming',`resolve ms=${Date.now()-start} outcome=ok source=${result.source??'network'} codec=${v?.codec??'unknown'} resolution=${v?normalizedDouyinResolution(v)??0:0} bitrate=${v?.bitrate??0}`);return {...result,data:item};}
    if(options.prefetch)this.cachePrefetchFailure(id,result);
    appLogger.i('DouyinTiming',`resolve ms=${Date.now()-start} outcome=${result.code}`);return result;
  }
  resetPrefetchFailures(){this.prefetchFailures.clear();}
  async clearPlaybackWindow(){this.clearFeedCache();await this.feedStore.clear();}
  async restoreFeed(){await this.prepareHistory();const snapshot=await this.feedStore.bootstrap();traceServiceWork("douyin.restore.result",()=>{for(const item of snapshot.items){const resolvedAtMillis=Number(snapshot.resolved[item.awemeId]);if(Number.isFinite(resolvedAtMillis)&&this.now()<douyinMediaExpiry(item.playUrl,resolvedAtMillis))this.cacheItem(item,resolvedAtMillis);}this.feedCursor=snapshot.cursor;this.feedHasMore=snapshot.hasMore;});return snapshot;}
  async saveRecentWindow(items:DouyinItem[],anchorAwemeId:string,cursor:string|null,hasMore:boolean){
    const normalized=normalizeItems(items),index=normalized.findIndex(x=>x.awemeId===anchorAwemeId);if(index<0)return;
    const bootstrap=normalized.slice(index,index+40),window=bootstrap.slice(0,4);
    const snapshot={anchorAwemeId,cursor,hasMore,savedAtMillis:this.now(),resolved:Object.fromEntries(bootstrap.map(item=>[item.awemeId,this.feedCache.get(item.awemeId)?.resolvedAtMillis??0]))};
    await this.feedStore.save(RECENT_KEY,{...snapshot,items:window});
    appLogger.d("DouyinFeedVM",`persist recent window reason=playback anchor=${logPlatformId(anchorAwemeId)} items=${window.length}`);
    await this.feedStore.save(FEED_KEY,{...snapshot,items:bootstrap});
  }

  async savePlaybackQueue(items:DouyinItem[],anchorAwemeId:string,cursor:string|null,hasMore:boolean){
    await this.feedStore.save(QUEUE_KEY,{items:items.slice(0,200),anchorAwemeId,cursor,hasMore,savedAtMillis:this.now(),resolved:Object.fromEntries(items.map(item=>[item.awemeId,this.feedCache.get(item.awemeId)?.resolvedAtMillis??0]))});
  }
  async restorePlaybackQueue(){return this.feedStore.read(QUEUE_KEY);}

  prepareHistory(){return this.history.initialize();}
  recordHistory(item:DouyinItem){return this.history.record(item,this.now());}
  recordPresented(item:DouyinItem):Promise<void>{
    const generation=this.authGeneration;
    const remember=(async()=>{
      if(!item.awemeId.trim()||!item.playUrl.trim())return;
      const cookie=await this.readCookie();
      if(cookie)await this.enqueueCookie(async()=>{
        if(!await this.currentAuth(cookie,generation))return;
        const store=this.options.historyStorage??this.options.secureStorage,key=douyinFeedSeenKey(cookie),previous=await readDouyinSeenIds(store,key);
        if(await this.currentAuth(cookie,generation))await store.set(key,JSON.stringify(rememberRecommendationIds(previous,[item.awemeId])));
      });
    })();return remember;
  }
  listHistory():Promise<DouyinHistoryEntry[]>{return this.history.list();}
  clearHistory(){return this.history.clear();}
  markWatchedId(awemeId:string){return this.history.mark(awemeId);}
  listWatchedIds():Promise<string[]>{return this.history.watched();}
  async clearWatchActivity(){await this.clearHistory();}
  async getSavedState(awemeId:string){return this.saved.state(awemeId);}
  async listSaved(kind?:DouyinSavedKind){return (await this.saved.list(kind)).map(entry=>({...entry,item:applyPreferredDouyinPlayback(entry.item)}));}
  async setSaved(item:DouyinItem,kind:DouyinSavedKind,saved:boolean){return this.saved.set(applyPreferredDouyinPlayback(item),kind,saved);}
  async toggleSaved(item:DouyinItem,kind:DouyinSavedKind){return this.saved.toggle(applyPreferredDouyinPlayback(item),kind);}
  async search(_query:string):Promise<DouyinResult<never>>{return fail("UNSUPPORTED","原 Android 抖音仓库没有搜索契约，未发送网络请求");}
  async interact(_awemeId:string,_action:DouyinInteraction):Promise<DouyinResult<never>>{return fail("UNSUPPORTED","原 Android 抖音仓库没有互动写入契约，未发送网络请求");}
}
