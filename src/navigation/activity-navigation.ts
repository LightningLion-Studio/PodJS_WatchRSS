import {createRestorableStack,createRouteMemoryAllocator} from '@podjs/framework/restorable-stack';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {stringToUtf8} from '@podjs/framework/bytes';
import type {ActivityState} from '@podjs/framework/services';
import type {RouteEntry,Page} from '../ui/routes/types.ts';
import {routeIsKnown} from '../ui/routes/meta.ts';
import {validateResumeTarget} from './resume-state.ts';

export const CONTENT_ACTIVITY_KEY='watchrss.content-activity';
export interface RouteMemory {id:string;saved:Record<string,unknown>;retained:Record<string,unknown>}
export type ActivityRoute=RouteEntry&{memory?:RouteMemory;articleId?:string;videoTarget?:VideoTarget};
export type VideoTarget={kind:'bili';aid?:number|string;bvid?:string;cid:number|string;title?:string}
 |{kind:'douyin';awemeId:string;immersive?:boolean;detailPlayback?:boolean}|{kind:'rss';articleId:string;url:string};
interface Descriptor {page:Page;id:string;args:Record<string,unknown>;ui:Record<string,unknown>}
const identities=createRouteMemoryAllocator<ActivityRoute>('r');
export const routeMemory=identities.memory;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048):v is string=>typeof v==='string'&&v.length<=max;
const identifier=(v:unknown):v is string=>text(v,256)&&!!v.trim();
const json=(value:unknown,depth=0):boolean=>depth<12&&(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||text(value,32768)||Array.isArray(value)&&value.length<=256&&value.every(v=>json(v,depth+1))||object(value)&&Object.keys(value).length<=96&&Object.entries(value).every(([k,v])=>text(k,96)&&!['__proto__','prototype','constructor'].includes(k)&&json(v,depth+1)));
function data(value:unknown,max:number):Record<string,unknown>{return object(value)&&json(value)&&stringToUtf8(JSON.stringify(value)).length<=max?value:{};}
const fields=['channelId','noteId','addUrl','imageUrl','imageFilePath','informationPage','exportMode','phoneAbilityLabel','returnRemoteUrl','unavailableMessage','recommendationGroup','readerFromWatchLater'] as const;
const information=new Set(['about','collaborators','contact-developer','join-group','info','beian','privacy','useragreement','licenses','log-upload-privacy']);
function argsFor(entry:ActivityRoute):Record<string,unknown>{
 const args:Record<string,unknown>={};
 for(const key of fields){const v=entry[key];if(v!==undefined&&(typeof v==='boolean'||text(v)))args[key]=v;}
 const articleId=entry.readerArticle?.id??entry.articleId;if(identifier(articleId))args.articleId=articleId;
 if(entry.biliRoute){const target=validateResumeTarget({version:1,kind:'bili',route:entry.biliRoute});args.biliRoute=target?.kind==='bili'?target.route:{name:'login'};}
 if(entry.douyinRoute){const target=validateResumeTarget({version:1,kind:'douyin',route:entry.douyinRoute});args.douyinRoute=target?.kind==='douyin'?target.route:{name:'login'};}
 if(entry.videoTarget){
  const t=entry.videoTarget;
  const identity=t.kind==='bili'?{kind:t.kind,aid:t.aid,bvid:t.bvid,cid:t.cid,title:t.title}
   :t.kind==='douyin'?{kind:t.kind,awemeId:entry.playback?.awemeId??t.awemeId,immersive:t.immersive,...(t.detailPlayback?{detailPlayback:true}:{})}
   :{kind:t.kind,articleId:t.articleId,url:t.url};
  args.videoTarget=JSON.parse(JSON.stringify(identity));
 }
 return args;
}
function decodedRoute(raw:Descriptor,retained:unknown,debug:boolean):ActivityRoute|null {
 if(!object(raw)||!routeIsKnown(raw.page)||!identifier(raw.id)||!/^r[1-9]\d{0,8}$/.test(raw.id)||!object(raw.args)||!json(raw.ui))return null;
 if((raw.page==='debug-tools'||raw.page==='debug-summary')&&!debug)return null;
 const a=raw.args,entry:ActivityRoute={page:raw.page,memory:{id:raw.id,saved:data(raw.ui,16384),retained:data(retained,524288)}};
 for(const key of fields)if(Object.hasOwn(a,key)){
  const v=a[key];if(key==='returnRemoteUrl'||key==='readerFromWatchLater'){if(typeof v!=='boolean')return null;}
  else if(!text(v))return null;
  Object.assign(entry,{[key]:v});
 }
 if(a.articleId!==undefined){if(!identifier(a.articleId))return null;entry.articleId=a.articleId;}
 if(entry.informationPage&&!information.has(entry.informationPage))return null;
 if(entry.exportMode&&!['favorite','watchLater','bili'].includes(entry.exportMode))return null;
 if(a.biliRoute!==undefined){
  const target=validateResumeTarget({version:1,kind:'bili',route:a.biliRoute});
  if(target?.kind==='bili')entry.biliRoute=target.route as RouteEntry['biliRoute'];
  else if(object(a.biliRoute)&&a.biliRoute.name==='login')entry.biliRoute={name:'login'};
  else return null;
 }
 if(a.douyinRoute!==undefined){
  const target=validateResumeTarget({version:1,kind:'douyin',route:a.douyinRoute});
  if(target?.kind==='douyin')entry.douyinRoute=target.route as RouteEntry['douyinRoute'];
  else if(object(a.douyinRoute)&&a.douyinRoute.name==='login')entry.douyinRoute={name:'login'};
  else return null;
 }
 if(a.videoTarget!==undefined){
  const t=a.videoTarget;if(!object(t))return null;
  if(t.kind==='bili'){
   const target=validateResumeTarget({version:1,kind:'bili',route:{...t,name:'detail'}});
   if(target?.kind!=='bili'||!(typeof t.cid==='number'&&Number.isFinite(t.cid)||identifier(t.cid)))return null;
   entry.videoTarget={kind:'bili',...target.route,cid:t.cid} as VideoTarget;
  }else if(t.kind==='douyin'&&identifier(t.awemeId))entry.videoTarget={kind:'douyin',awemeId:t.awemeId,immersive:t.immersive===true,...(t.detailPlayback===true?{detailPlayback:true}:{})};
  else if(t.kind==='rss'&&identifier(t.articleId)&&text(t.url)&&!!t.url)entry.videoTarget={kind:'rss',articleId:t.articleId,url:t.url};
  else return null;
 }
 if(['reader','rss-actions','rss-share','debug-summary'].includes(entry.page)&&!entry.articleId)return null;
 if(['articles','search','channel-detail','channel-settings','channel-share'].includes(entry.page)&&!identifier(entry.channelId))return null;
 if(entry.page==='note-actions'&&!identifier(entry.noteId))return null;
 if(entry.page==='reader-image'&&!entry.imageUrl)return null;
 if(entry.page==='video'&&!entry.videoTarget)return null;
 return entry;
}

const stack=createRestorableStack<ActivityRoute,Descriptor,boolean>({
 namespace:CONTENT_ACTIVITY_KEY,version:1,maxEntries:24,maxSavedBytes:24576,maxRetainedBytes:640*1024,
 memory:routeMemory,captureContext:true,decode:(raw,retained,debug)=>decodedRoute(raw as Descriptor,retained,debug),
 encode(entry,memory){const args=argsFor(entry);return json(args)?{page:entry.page,id:memory.id,args,ui:data(memory.saved,16384)}:null;},
 retained:memory=>data(memory.retained,524288),isRoot:entry=>entry.page==='home',restoredIds:ids=>identities.observe(ids),
});
const captureActivityNavigationImpl=stack.capture;
/** Recover the last valid prefix; routes, debug policy and entity validation stay here. */
export function restoreActivityNavigation(state:ActivityState,debug=false):ActivityRoute[]|null {return stack.restore(state,debug);}
export function resolveActivityNavigation(entries:ActivityRoute[],resolver:{hasChannel:(id:string)=>boolean;article:(id:string)=>Promise<RouteEntry['readerArticle']|null>;canRestore?:(entry:ActivityRoute)=>boolean}):Promise<ActivityRoute[]>{
 return stack.resolve<RouteEntry['readerArticle']|null>(entries,entry=>{
  if(resolver.canRestore&&!resolver.canRestore(entry))return false;
  if(entry.channelId&&!resolver.hasChannel(entry.channelId))return false;
  if(entry.articleId)return {result:resolver.article(entry.articleId),accept(article){if(!article)return false;entry.readerArticle=article;return true;}};
  return true;
 },()=>({page:'home'}));
}

export function captureActivityNavigation(...args:Parameters<typeof captureActivityNavigationImpl>) {return traceServiceWork("reader.captureActivity",()=>captureActivityNavigationImpl(...args));}

const NAVIGATION_CHECKPOINT_KEY='watchrss.navigation-checkpoint.v1';
/** Persist only content saved state; startup consent and retained drafts have
 * separate owners and must not become durable through a route checkpoint. */
export function writeNavigationCheckpoint(storage:{set(key:string,value:unknown):void},state:ActivityState):void {
 storage.set(NAVIGATION_CHECKPOINT_KEY,{version:1,saved:{[CONTENT_ACTIVITY_KEY]:state.saved[CONTENT_ACTIVITY_KEY]}});
}
export function readNavigationCheckpoint(storage:{get<T>(key:string):T|undefined},debug=false):ActivityRoute[]|null {
 const raw=storage.get<unknown>(NAVIGATION_CHECKPOINT_KEY);
 if(!object(raw)||raw.version!==1||!object(raw.saved))return null;
 return restoreActivityNavigation({saved:raw.saved,retained:{}},debug);
}
