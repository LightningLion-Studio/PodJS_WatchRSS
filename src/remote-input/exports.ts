import {BiliError,type BiliHistoryCursor,type BiliHistoryPage} from '../bili/types.ts';
import type {BiliPlaybackProgress} from '../bili/playback.ts';
import type {SavedLinkType} from '../sync/saved-links.ts';
import {nativeTrim} from '../sync/local-manifest.ts';

export const EXPORT_ABILITIES = {
 favorite:{code:'c4bf141f-b0de-46f7-a661-0a3ad0716bce',name:'收藏夹',version:'0.0.1'},
 watchLater:{code:'f1aa43bd-0fe3-4771-ae6b-d4799ecf84b5',name:'稍后阅读',version:'0.0.1'},
 bili:{code:'9a88f4ec-a071-4cf4-8b25-e735836ebb0d',name:'B站观看历史/进度',version:'0.0.1'},
} as const;
export type HttpExportMode = keyof typeof EXPORT_ABILITIES;
export interface HttpExportSource {
 readSavedLinks(type:SavedLinkType):Promise<string[]>;
 history(cursor?:BiliHistoryCursor):Promise<BiliHistoryPage>;
 playbackProgress():Promise<BiliPlaybackProgress[]>;
}
export interface HttpExportSession {mode:HttpExportMode;source:HttpExportSource;onComplete?:()=>void}
const present=(value:string|undefined)=>value!==undefined&&nativeTrim(value)?value:undefined;
function savedLink(bvid?:string,aid?:number,cid?:number){
 const base=present(bvid)?`https://www.bilibili.com/video/${bvid}`:aid!=null?`https://www.bilibili.com/video/av${aid}`:undefined;
 return base===undefined?undefined:cid==null?base:`${base}?cid=${cid}`;
}
export function historyPayload(page:BiliHistoryPage){
 const c=page.cursor;
 return {cursor:c?{max:c.max,viewAt:c.viewAt,business:present(c.business),ps:c.pageSize}:null,
  items:page.items.map(i=>{const h=i.history;return {aid:h?.oid,bvid:present(h?.bvid),cid:h?.cid,page:h?.page,part:present(h?.part),business:present(h?.business),title:present(i.title),cover:present(i.cover),viewAt:i.viewAt,durationSeconds:i.duration,progressSeconds:i.progress,authorName:present(i.authorName),authorMid:i.authorMid,link:savedLink(h?.bvid,h?.oid,h?.cid)};})};
}
export function playbackPayload(records:BiliPlaybackProgress[]){return records.map(r=>({aid:r.aid,bvid:present(r.bvid),cid:r.cid,positionMs:r.positionMs,durationMs:r.durationMs,updatedAtMillis:r.updatedAt,link:savedLink(r.bvid,r.aid,r.cid)}));}
/** BiliRepository.safeCall reports network failures as business error 9001. */
export function historyFailure(error:unknown){
 const code=error instanceof BiliError?error.code??9001:9001;
 let message=error instanceof BiliError&&(error.kind==='transport'||error.kind==='timeout')?'网络不可用':error instanceof Error?nativeTrim(error.message):'';
 if(message==='missing_csrf')message='缺少 CSRF';
 else if(message.startsWith('missing_cookie:'))message='Cookie 缺少 '+message.slice(15);
 else if(message==='cookie_incomplete')message='Cookie 不完整';
 else if(message==='invalid_json')message='响应解析失败';
 const fixed:Record<number,string>={9002:'缺少用户信息',9003:'未找到收藏夹',9006:'缺少播放参数',9007:'暂无可播放地址',86038:'二维码已过期',86039:'已扫码，请在手机上确认',86090:'已扫码，请在手机上确认',86101:'等待扫码'};
 const fallback:Record<number,string>={9001:'网络请求失败',9004:'获取登录二维码失败',9005:'Cookie 无效',[-101]:'登录已失效',[-111]:'缺少 CSRF',[-352]:'触发风控校验',[-401]:'请求未认证',[-412]:'请求被风控拦截'};
 return {success:false,code,message:fixed[code]??(message||fallback[code]||`加载失败(-${Math.abs(code)})`),data:null};
}
