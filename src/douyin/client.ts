import {DouyinHistoryStore} from './history-store.ts';
import {applyPreferredDouyinPlayback,selectPreferredDouyinVariant,normalizedDouyinResolution} from './playback-selector.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {logPlatformId} from '../logs/fields.ts';
import {appLogger} from '../logs/app-logger.ts';
import {formatDouyinError,mediaRequestFailure} from './errors.ts';
import { DouyinFeedStore, FEED_KEY, RECENT_KEY, QUEUE_KEY, normalizeItems } from "./feed-store.ts";
import {decodeMediaText} from '../media/text.ts';
import { parseDouyinDetail, parseDouyinFeedAsync } from "./parser.ts";
import { ABogusSigner } from "./signing.ts";
import { DouyinSavedStore } from "./saved.ts";
import type { DouyinClientOptions, DouyinContent, DouyinFeedPage, DouyinHistoryEntry, DouyinInteraction, DouyinItem, DouyinResult, DouyinSavedKind, DouyinSigner } from "./types.ts";

export const DOUYIN_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36";
export const DOUYIN_REFERER="https://www.douyin.com/";
export const DOUYIN_PUBLIC_MEDIA_HEADERS:Readonly<Record<string,string>>=Object.freeze({"User-Agent":DOUYIN_USER_AGENT,Referer:DOUYIN_REFERER});
const COOKIE_KEY="douyin.cookie";
const PLAY_URL_TTL_MS=5*60*1000;
// DouyinWebCrawler uses OkHttp defaults: 10s connect/read/write, no call timeout.
export const DOUYIN_NETWORK_TIMEOUT_MS=10_000;
const baseParams:Record<string,string>={device_platform:"webapp",aid:"6383",channel:"channel_pc_web",pc_client_type:"1",version_code:"290100",version_name:"29.1.0",cookie_enabled:"true",screen_width:"680",screen_height:"907",browser_language:"zh-CN",browser_platform:"Win32",browser_name:"Chrome",browser_version:"130.0.0.0",browser_online:"true",engine_name:"Blink",engine_version:"130.0.0.0",os_name:"Windows",os_version:"10",cpu_core_num:"12",device_memory:"8",platform:"PC",downlink:"10",effective_type:"4g",from_user_page:"1",locate_query:"false",need_time_list:"1",pc_libra_divert:"Windows",publish_video_strategy_type:"2",round_trip_time:"0",show_live_replay_strategy:"1",time_list_query:"0",whale_cut_token:"",update_version_code:"170400",msToken:""};
const query=(p:Record<string,string>)=>Object.keys(p).map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join("&");
const fail=<T>(code:"NOT_LOGGED_IN"|"REQUEST_FAILED"|"PARSE_FAILED"|"UNSUPPORTED"|"CANCELLED",message:string):DouyinResult<T>=>({ok:false,code,message});
export class DouyinClient {
  private readonly authExpiredListeners=new Set<()=>void>();
  onAuthExpired(listener:()=>void){this.authExpiredListeners.add(listener);return ()=>{this.authExpiredListeners.delete(listener);};}
  private async expireAuthentication(){
    await this.clearCookie();
    for(const listener of this.authExpiredListeners)listener();
    return fail<never>('NOT_LOGGED_IN','登录已失效，请重新登录');
  }
  private readonly now:()=>number;
  private readonly signer:DouyinSigner;
  private readonly saved:NonNullable<DouyinClientOptions["savedStore"]>;
  private readonly detailRequests=new Map<string,object>();
  private readonly playbackResolutions=new Map<string,Promise<DouyinResult<DouyinItem>>>();
  private readonly feedCache=new Map<string,{item:DouyinItem;resolvedAtMillis:number}>();
  private readonly feedStore:DouyinFeedStore;
  private feedCursor:string|null=null;
  private feedHasMore=false;
  private readonly history:DouyinHistoryStore;

  constructor(private readonly options:DouyinClientOptions){this.feedStore=new DouyinFeedStore(options.historyStorage??options.secureStorage);this.history=new DouyinHistoryStore(options.historyStorage??options.secureStorage);this.now=options.now??Date.now;this.signer=options.signer??new ABogusSigner();this.saved=options.savedStore??new DouyinSavedStore(options.savedStorage??options.historyStorage??options.secureStorage,this.now);}
  async readCookie(){const raw=await traceServiceWork("douyin.cookie.request",()=>this.options.secureStorage.get(COOKIE_KEY));return traceServiceWork("douyin.cookie.result",()=>raw?.trim()||null,raw?.length??0);}
  async isLoggedIn(){return (await this.readCookie())!==null;}
  private clearFeedCache(){this.detailRequests.clear();this.playbackResolutions.clear();this.feedCache.clear();this.feedCursor=null;this.feedHasMore=false;}
  async applyCookie(raw:string,commitCookie:(value:string)=>Promise<void>=value=>this.options.secureStorage.set(COOKIE_KEY,value)){const value=raw.trim();if(!value)return fail<void>("NOT_LOGGED_IN","缺少有效 Cookie");await commitCookie(value);this.clearFeedCache();await this.feedStore.clear();return {ok:true,data:undefined} as DouyinResult<void>;}
  async clearCookie(commitCookie:()=>Promise<void>=()=>this.options.secureStorage.remove(COOKIE_KEY)){await commitCookie();this.clearFeedCache();await this.feedStore.clear();}
  async logout(){await this.clearCookie();await this.options.onLogout?.();}
  async buildPlaybackHeaders(){const cookie=await this.readCookie();return {...DOUYIN_PUBLIC_MEDIA_HEADERS,...(cookie?{Cookie:cookie}:{})};}
  private async get(path:string,params:Record<string,string>,method:"GET"|"POST"):Promise<DouyinResult<string>> {
    appLogger.d('DouyinClient',`${method} ${path}`);
    const cookie=await this.readCookie();if(!cookie)return fail('NOT_LOGGED_IN','未登录');
    let signed:string;
    try{signed=await this.signer.sign(params);}
    catch{appLogger.e('DouyinClient',`request failed path=${path} category=signing`);return fail('REQUEST_FAILED',formatDouyinError('REQUEST_FAILED'));}
    const url=`https://www.douyin.com${path}?${query({...params,a_bogus:signed})}`;
    try{
      const r=await this.options.transport.request({method,url,headers:{...DOUYIN_PUBLIC_MEDIA_HEADERS,Cookie:cookie,Accept:'application/json',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}:{})},
        timeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,readTimeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,acceptHttpErrors:true,...(method==='POST'?{body:new Uint8Array(0)}:{})});
      appLogger.d('DouyinClient',`response path=${path} status=${r.status}`);
      if(r.status===403){appLogger.e('DouyinClient',`request failed path=${path} category=http status=403`);return await this.expireAuthentication();}
      if(r.status!==200){appLogger.e('DouyinClient',`request failed path=${path} category=http status=${r.status}`);return fail('REQUEST_FAILED',`请求失败，状态码：${r.status}（仅支持200）`);}
      const body=await decodeMediaText(r.body);
      if(!body.trim()||body==='blocked'){
        const category=body==='blocked'?'blocked':'empty';
        appLogger.w('DouyinClient',`request failed path=${path} category=authentication reason=${category}`);
        return fail('NOT_LOGGED_IN',body==='blocked'?'Cookie无效：响应体为blocked':'Cookie无效：响应体为空字符串');
      }
      return {ok:true,data:body};
    }catch(error){
      const failure=mediaRequestFailure(error);
      if(failure.status===403){appLogger.e('DouyinClient',`request failed path=${path} category=${failure.category} status=403`);return await this.expireAuthentication();}
      appLogger.e('DouyinClient',`request failed path=${path} category=${failure.category}${failure.status===undefined?'':` status=${failure.status}`}`);
      return fail(failure.category==='cancelled'?'CANCELLED':'REQUEST_FAILED',failure.status===undefined?formatDouyinError('REQUEST_FAILED'):`请求失败，状态码：${failure.status}（仅支持200）`);
    }
  }
  private freshFeedItem(awemeId:string):DouyinItem|null{const cached=this.feedCache.get(awemeId);if(!cached)return null;if(this.now()-cached.resolvedAtMillis>=PLAY_URL_TTL_MS){this.feedCache.delete(awemeId);return null;}return cached.item.playUrl.trim()?cached.item:null;}
  async fetchFeedPage(input:{cursor?:string|null;count?:number}={}):Promise<DouyinResult<DouyinFeedPage>>{await this.prepareHistory();const count=Math.max(1,Math.min(20,Math.floor(input.count??10))),params:Record<string,string>={...baseParams,count:String(count)};const cursor=input.cursor?.trim();if(cursor){params.cursor=cursor;params.max_cursor=cursor;}const r=await this.get("/aweme/v2/web/module/feed/",params,"POST");if(!r.ok)return r;try{const data=await parseDouyinFeedAsync(r.data),resolvedAtMillis=this.now();for(const item of data.items)this.feedCache.set(item.awemeId,{item,resolvedAtMillis});this.feedCursor=data.nextCursor;this.feedHasMore=data.hasMore;await this.feedStore.save(FEED_KEY,{items:data.items.slice(0,20),cursor:data.nextCursor,hasMore:data.hasMore,anchorAwemeId:null,savedAtMillis:resolvedAtMillis,resolved:Object.fromEntries(data.items.map(item=>[item.awemeId,resolvedAtMillis]))});return {ok:true,data,source:"network"};}catch{appLogger.e('DouyinClient','feed failed category=parse_or_cache');return fail("PARSE_FAILED",formatDouyinError("PARSE_FAILED"));}}
  feedSnapshot(){const items:DouyinItem[]=[];for(const id of this.feedCache.keys()){const item=this.freshFeedItem(id);if(item)items.push(item);}return {items:items.slice(-40),cursor:this.feedCursor,hasMore:this.feedHasMore};}
  async fetchDetail(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinContent>>{const id=awemeId.trim();if(!id)return fail("PARSE_FAILED","缺少 awemeId");const initialCached=this.freshFeedItem(id);if(initialCached&&!options.forceRefresh)return {ok:true,data:{kind:"video",item:initialCached},source:"feed-cache"};const token={};this.detailRequests.set(id,token);const r=await this.get("/aweme/v1/web/aweme/detail/",{...baseParams,aweme_id:id},"GET");if(!r.ok&&r.code==="NOT_LOGGED_IN")return r;if(this.detailRequests.get(id)!==token)return fail("CANCELLED",formatDouyinError("CANCELLED"));this.detailRequests.delete(id);if(!r.ok){const cached=this.freshFeedItem(id);return cached?{ok:true,data:{kind:"video",item:cached},source:"feed-cache"}:r;}try{const data=traceServiceWork("douyin.detail.parse",()=>parseDouyinDetail(r.data));if(data.kind==="video")this.feedCache.set(id,{item:data.item,resolvedAtMillis:this.now()});return {ok:true,data,source:"network"};}catch(e){const cached=this.freshFeedItem(id);return cached?{ok:true,data:{kind:"video",item:cached},source:"feed-cache"}:fail("PARSE_FAILED",String(e));}}
  private async resolvePlaybackInner(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinItem>>{const id=awemeId.trim();if(options.forceRefresh)this.feedCache.delete(id);const cached=this.freshFeedItem(id);if(cached)return {ok:true,data:cached,source:"feed-cache"};const r=await this.fetchDetail(id);return !r.ok?r:r.data.kind==="video"?{ok:true,data:r.data.item,source:r.source}:fail("UNSUPPORTED","图文内容没有视频播放流");}
  async resolvePlayback(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinItem>>{
    const start=Date.now(),id=awemeId.trim(),key=JSON.stringify([id,options.forceRefresh===true]);let pending=this.playbackResolutions.get(key);if(!pending){pending=this.resolvePlaybackInner(id,options);this.playbackResolutions.set(key,pending);}let result:DouyinResult<DouyinItem>;try{result=await pending;}finally{if(this.playbackResolutions.get(key)===pending)this.playbackResolutions.delete(key);}
    if(result.ok){const item=applyPreferredDouyinPlayback(result.data);if(!item.playUrl.trim())return fail('UNSUPPORTED','没有可用的视频播放流');const v=selectPreferredDouyinVariant(item.variants??[]);appLogger.i('DouyinTiming',`resolve ms=${Date.now()-start} outcome=ok source=${result.source??'network'} codec=${v?.codec??'unknown'} resolution=${v?normalizedDouyinResolution(v)??0:0} bitrate=${v?.bitrate??0}`);return {...result,data:item};}
    appLogger.i('DouyinTiming',`resolve ms=${Date.now()-start} outcome=${result.code}`);return result;
  }
  async clearPlaybackWindow(){this.clearFeedCache();await this.feedStore.clear();}
  async restoreFeed(){await this.prepareHistory();const snapshot=await this.feedStore.bootstrap();traceServiceWork("douyin.restore.result",()=>{for(const item of snapshot.items){const resolvedAtMillis=Number(snapshot.resolved[item.awemeId]);if(Number.isFinite(resolvedAtMillis)&&this.now()-resolvedAtMillis<PLAY_URL_TTL_MS)this.feedCache.set(item.awemeId,{item,resolvedAtMillis});}this.feedCursor=snapshot.cursor;this.feedHasMore=snapshot.hasMore;});return snapshot;}
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
