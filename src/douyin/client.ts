import {appLogger} from '../logs/app-logger.ts';
import { DouyinFeedStore, FEED_KEY, RECENT_KEY, QUEUE_KEY, normalizeItems } from "./feed-store.ts";
import { utf8Decode } from "../cloud/types.ts";
import { parseDouyinDetail, parseDouyinFeed } from "./parser.ts";
import { ABogusSigner } from "./signing.ts";
import { DouyinSavedStore } from "./saved.ts";
import type { DouyinClientOptions, DouyinContent, DouyinFeedPage, DouyinHistoryEntry, DouyinInteraction, DouyinItem, DouyinResult, DouyinSavedKind, DouyinSigner } from "./types.ts";

export const DOUYIN_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36";
export const DOUYIN_REFERER="https://www.douyin.com/";
export const DOUYIN_PUBLIC_MEDIA_HEADERS:Readonly<Record<string,string>>=Object.freeze({"User-Agent":DOUYIN_USER_AGENT,Referer:DOUYIN_REFERER});
const COOKIE_KEY="douyin.cookie", HISTORY_KEY="douyin.history.v1";
const WATCHED_KEY="douyin.watched.v1";
const PLAY_URL_TTL_MS=5*60*1000;
const baseParams:Record<string,string>={device_platform:"webapp",aid:"6383",channel:"channel_pc_web",pc_client_type:"1",version_code:"290100",version_name:"29.1.0",cookie_enabled:"true",screen_width:"680",screen_height:"907",browser_language:"zh-CN",browser_platform:"Win32",browser_name:"Chrome",browser_version:"130.0.0.0",browser_online:"true",engine_name:"Blink",engine_version:"130.0.0.0",os_name:"Windows",os_version:"10",cpu_core_num:"12",device_memory:"8",platform:"PC",downlink:"10",effective_type:"4g",from_user_page:"1",locate_query:"false",need_time_list:"1",pc_libra_divert:"Windows",publish_video_strategy_type:"2",round_trip_time:"0",show_live_replay_strategy:"1",time_list_query:"0",whale_cut_token:"",update_version_code:"170400",msToken:""};
const query=(p:Record<string,string>)=>Object.keys(p).map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join("&");
const fail=<T>(code:"NOT_LOGGED_IN"|"REQUEST_FAILED"|"PARSE_FAILED"|"UNSUPPORTED"|"CANCELLED",message:string):DouyinResult<T>=>({ok:false,code,message});
export class DouyinClient {
  private readonly now:()=>number;
  private readonly signer:DouyinSigner;
  private readonly saved:NonNullable<DouyinClientOptions["savedStore"]>;
  private readonly feedCache=new Map<string,{item:DouyinItem;resolvedAtMillis:number}>();
  private readonly feedStore:DouyinFeedStore;
  private feedCursor:string|null=null;
  private feedHasMore=false;
  private historyWrites:Promise<void>=Promise.resolve();
  private writeHistory(write:()=>Promise<void>){
    const pending=this.historyWrites.catch(()=>{}).then(write);
    this.historyWrites=pending;return pending;
  }

  constructor(private readonly options:DouyinClientOptions){this.feedStore=new DouyinFeedStore(options.historyStorage??options.secureStorage);this.now=options.now??Date.now;this.signer=options.signer??new ABogusSigner();this.saved=options.savedStore??new DouyinSavedStore(options.savedStorage??options.historyStorage??options.secureStorage,this.now);}
  async readCookie(){return (await this.options.secureStorage.get(COOKIE_KEY))?.trim()||null;}
  async isLoggedIn(){return (await this.readCookie())!==null;}
  private clearFeedCache(){this.feedCache.clear();this.feedCursor=null;this.feedHasMore=false;}
  async applyCookie(raw:string){const value=raw.trim();if(!value)return fail<void>("NOT_LOGGED_IN","缺少有效 Cookie");await this.options.secureStorage.set(COOKIE_KEY,value);this.clearFeedCache();await this.feedStore.clear();return {ok:true,data:undefined} as DouyinResult<void>;}
  async logout(){await this.options.secureStorage.remove(COOKIE_KEY);this.clearFeedCache();await this.feedStore.clear();await this.options.onLogout?.();}
  async buildPlaybackHeaders(){const cookie=await this.readCookie();return {...DOUYIN_PUBLIC_MEDIA_HEADERS,...(cookie?{Cookie:cookie}:{})};}
  private async get(path:string,params:Record<string,string>,method:"GET"|"POST"):Promise<DouyinResult<string>>{appLogger.d('DouyinClient',`${method} ${path}`);const cookie=await this.readCookie();if(!cookie)return fail<string>("NOT_LOGGED_IN","未登录");let signed:string;try{signed=await this.signer.sign(params);}catch(e){appLogger.e('DouyinClient','Request failed',e);return fail("REQUEST_FAILED",`抖音请求签名失败：${String(e)}`);} const url=`https://www.douyin.com${path}?${query({...params,a_bogus:signed})}`;try{const r=await this.options.transport.request({method,url,headers:{...(await this.buildPlaybackHeaders()),Accept:"application/json",...(method==="POST"?{"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"}:{})},...(method==="POST"?{body:new Uint8Array(0)}:{})});appLogger.d('DouyinClient',`response status=${r.status}`);const body=utf8Decode(r.body);if(r.status!==200)return fail("REQUEST_FAILED",`请求失败，状态码：${r.status}（仅支持200）`);if(!body.trim()||body.trim()==="blocked")return fail("NOT_LOGGED_IN","Cookie 无效：响应为空或被拦截");return {ok:true,data:body};}catch(e){appLogger.e('DouyinClient','Request failed',e);return fail("REQUEST_FAILED",String(e));}}
  private freshFeedItem(awemeId:string):DouyinItem|null{const cached=this.feedCache.get(awemeId);if(!cached)return null;if(this.now()-cached.resolvedAtMillis>=PLAY_URL_TTL_MS){this.feedCache.delete(awemeId);return null;}return cached.item.playUrl.trim()?cached.item:null;}
  async fetchFeedPage(input:{cursor?:string|null;count?:number}={}):Promise<DouyinResult<DouyinFeedPage>>{const count=Math.max(1,Math.min(20,Math.floor(input.count??10))),params:Record<string,string>={...baseParams,count:String(count)};const cursor=input.cursor?.trim();if(cursor){params.cursor=cursor;params.max_cursor=cursor;}const r=await this.get("/aweme/v2/web/module/feed/",params,"POST");if(!r.ok)return r;try{const data=parseDouyinFeed(r.data),resolvedAtMillis=this.now();for(const item of data.items)this.feedCache.set(item.awemeId,{item,resolvedAtMillis});this.feedCursor=data.nextCursor;this.feedHasMore=data.hasMore;await this.feedStore.save(FEED_KEY,{items:data.items.slice(0,20),cursor:data.nextCursor,hasMore:data.hasMore,anchorAwemeId:null,savedAtMillis:resolvedAtMillis,resolved:Object.fromEntries(data.items.map(item=>[item.awemeId,resolvedAtMillis]))});return {ok:true,data,source:"network"};}catch(e){return fail("PARSE_FAILED",String(e));}}
  feedSnapshot(){const items:DouyinItem[]=[];for(const id of this.feedCache.keys()){const item=this.freshFeedItem(id);if(item)items.push(item);}return {items:items.slice(-40),cursor:this.feedCursor,hasMore:this.feedHasMore};}
  async fetchDetail(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinContent>>{const id=awemeId.trim();if(!id)return fail("PARSE_FAILED","缺少 awemeId");const initialCached=this.freshFeedItem(id);if(initialCached&&!options.forceRefresh)return {ok:true,data:{kind:"video",item:initialCached},source:"feed-cache"};const r=await this.get("/aweme/v1/web/aweme/detail/",{...baseParams,aweme_id:id},"GET");if(!r.ok){const cached=this.freshFeedItem(id);return cached?{ok:true,data:{kind:"video",item:cached},source:"feed-cache"}:r;}try{const data=parseDouyinDetail(r.data);if(data.kind==="video")this.feedCache.set(id,{item:data.item,resolvedAtMillis:this.now()});return {ok:true,data,source:"network"};}catch(e){const cached=this.freshFeedItem(id);return cached?{ok:true,data:{kind:"video",item:cached},source:"feed-cache"}:fail("PARSE_FAILED",String(e));}}
  async resolvePlayback(awemeId:string,options:{forceRefresh?:boolean}={}):Promise<DouyinResult<DouyinItem>>{const id=awemeId.trim();if(options.forceRefresh)this.feedCache.delete(id);const cached=this.freshFeedItem(id);if(cached)return {ok:true,data:cached,source:"feed-cache"};const r=await this.fetchDetail(id);return !r.ok?r:r.data.kind==="video"?{ok:true,data:r.data.item,source:r.source}:fail("UNSUPPORTED","图文内容没有视频播放流");}
  async clearPlaybackWindow(){this.clearFeedCache();await this.feedStore.clear();}
  async restoreFeed(){const snapshot=await this.feedStore.bootstrap();for(const item of snapshot.items){const resolvedAtMillis=Number(snapshot.resolved[item.awemeId]);if(Number.isFinite(resolvedAtMillis)&&this.now()-resolvedAtMillis<PLAY_URL_TTL_MS)this.feedCache.set(item.awemeId,{item,resolvedAtMillis});}this.feedCursor=snapshot.cursor;this.feedHasMore=snapshot.hasMore;return snapshot;}
  async saveRecentWindow(items:DouyinItem[],anchorAwemeId:string,cursor:string|null,hasMore:boolean){
    const normalized=normalizeItems(items),index=normalized.findIndex(x=>x.awemeId===anchorAwemeId);if(index<0)return;
    const bootstrap=normalized.slice(index,index+40),window=bootstrap.slice(0,4);
    const snapshot={anchorAwemeId,cursor,hasMore,savedAtMillis:this.now(),resolved:Object.fromEntries(bootstrap.map(item=>[item.awemeId,this.feedCache.get(item.awemeId)?.resolvedAtMillis??0]))};
    await this.feedStore.save(RECENT_KEY,{...snapshot,items:window});
    await this.feedStore.save(FEED_KEY,{...snapshot,items:bootstrap});
  }

  async savePlaybackQueue(items:DouyinItem[],anchorAwemeId:string,cursor:string|null,hasMore:boolean){
    await this.feedStore.save(QUEUE_KEY,{items:normalizeItems(items).slice(0,200),anchorAwemeId,cursor,hasMore,savedAtMillis:this.now(),resolved:{}});
  }
  async restorePlaybackQueue(){return this.feedStore.read(QUEUE_KEY);}

  async recordHistory(item:DouyinItem){
    const id=item.awemeId.trim(),playUrl=item.playUrl.trim();if(!id||!playUrl)return;
    const snapshot={...item,awemeId:id,playUrl},watchedAtMillis=this.now();
    await this.writeHistory(async()=>{
      const store=this.options.historyStorage??this.options.secureStorage,old=await this.listHistory();
      const entries=[{item:snapshot,watchedAtMillis},...old.filter(x=>x.item.awemeId!==id)].slice(0,200);
      await store.set(HISTORY_KEY,JSON.stringify(entries));await this.writeWatchedId(id);
    });
  }
  async listHistory():Promise<DouyinHistoryEntry[]>{const raw=await (this.options.historyStorage??this.options.secureStorage).get(HISTORY_KEY);if(!raw)return [];try{const v=JSON.parse(raw);return Array.isArray(v)?v.filter(x=>x&&typeof x==="object"&&x.item?.awemeId&&Number.isFinite(Number(x.watchedAtMillis))):[];}catch{return [];}}
  async clearHistory(){await this.writeHistory(async()=>{const store=this.options.historyStorage??this.options.secureStorage;await store.remove(HISTORY_KEY);await store.remove(WATCHED_KEY);});}
  async markWatchedId(awemeId:string){await this.writeHistory(()=>this.writeWatchedId(awemeId));}
  private async writeWatchedId(awemeId:string){const id=awemeId.trim();if(!id)return;const store=this.options.historyStorage??this.options.secureStorage,ids=(await this.listWatchedIds()).filter(x=>x!==id);ids.push(id);await store.set(WATCHED_KEY,JSON.stringify(ids.slice(-1000)));}
  async listWatchedIds():Promise<string[]>{const raw=await (this.options.historyStorage??this.options.secureStorage).get(WATCHED_KEY);if(!raw)return [];try{const value=JSON.parse(raw);return Array.isArray(value)?value.map(String).map(x=>x.trim()).filter(Boolean).slice(-1000):[];}catch{return [];}}
  async clearWatchActivity(){await this.clearHistory();}
  async getSavedState(awemeId:string){return this.saved.state(awemeId);}
  async listSaved(kind?:DouyinSavedKind){return this.saved.list(kind);}
  async setSaved(item:DouyinItem,kind:DouyinSavedKind,saved:boolean){return this.saved.set(item,kind,saved);}
  async toggleSaved(item:DouyinItem,kind:DouyinSavedKind){return this.saved.toggle(item,kind);}
  async search(_query:string):Promise<DouyinResult<never>>{return fail("UNSUPPORTED","原 Android 抖音仓库没有搜索契约，未发送网络请求");}
  async interact(_awemeId:string,_action:DouyinInteraction):Promise<DouyinResult<never>>{return fail("UNSUPPORTED","原 Android 抖音仓库没有互动写入契约，未发送网络请求");}
}
