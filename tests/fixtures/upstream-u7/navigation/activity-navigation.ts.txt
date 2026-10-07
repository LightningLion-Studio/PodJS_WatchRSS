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
let sequence=0;
export function routeMemory(entry:ActivityRoute):RouteMemory{return entry.memory??=( {id:`r${++sequence}`,saved:{},retained:{}} );}
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
 if(raw.page==='debug-tools'&&!debug)return null;
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
 if(['reader','rss-actions','rss-share'].includes(entry.page)&&!entry.articleId)return null;
 if(['articles','search','channel-detail','channel-settings','channel-share'].includes(entry.page)&&!identifier(entry.channelId))return null;
 if(entry.page==='note-actions'&&!identifier(entry.noteId))return null;
 if(entry.page==='reader-image'&&!entry.imageUrl)return null;
 if(entry.page==='video'&&!entry.videoTarget)return null;
 return entry;
}

function captureActivityNavigationImpl(prior:ActivityState,entries:readonly ActivityRoute[]):ActivityState {
 const saved={...prior.saved},retained={...prior.retained};
 // Limit Android Bundle metadata; never serialize live handles, cookies or media headers.
 const descriptors:Descriptor[]=[],live:Record<string,unknown>={};
 for(const entry of entries.slice(0,24)){
  const memory=routeMemory(entry),args=argsFor(entry);
  if(!json(args))break;
  const descriptor={page:entry.page,id:memory.id,args,ui:data(memory.saved,16384)};
  if(!decodedRoute(descriptor,{},true))break;
  if(stringToUtf8(JSON.stringify([...descriptors,descriptor])).length>24576)break;
  descriptors.push(descriptor);
  const ui=data(memory.retained,524288);
  if(stringToUtf8(JSON.stringify({...live,[memory.id]:ui})).length<=640*1024)live[memory.id]=ui;
 }
 saved[CONTENT_ACTIVITY_KEY]={version:1,entries:descriptors};
 retained[CONTENT_ACTIVITY_KEY]={version:1,entries:live};
 return {saved,retained};
}

/** Unknown versions, malformed metadata and missing targets fall back to the
 * last valid prefix. This is Activity task restoration, separate from KV resume. */
export function restoreActivityNavigation(state:ActivityState,debug=false):ActivityRoute[]|null {
 const saved=state.saved[CONTENT_ACTIVITY_KEY],retained=state.retained[CONTENT_ACTIVITY_KEY];
 if(!object(saved)||saved.version!==1||!Array.isArray(saved.entries)||saved.entries.length>24)return null;
 const live=object(retained)&&retained.version===1&&object(retained.entries)?retained.entries:{};
 const result:ActivityRoute[]=[],ids=new Set<string>();
 for(const raw of saved.entries){
  const e=decodedRoute(raw,object(raw)?live[String(raw.id)]:undefined,debug);
  if(!e||ids.has(e.memory!.id))break;ids.add(e.memory!.id);result.push(e);
 }
 if(!result.length||result[0].page!=='home')return null;
 // New routes allocated after restore must not reuse saved IDs.
 for(const id of ids){const match=/^r(\d+)$/.exec(id);if(match)sequence=Math.max(sequence,Number(match[1]));}
 return result;
}

export async function resolveActivityNavigation(entries:ActivityRoute[],resolver:{hasChannel:(id:string)=>boolean;article:(id:string)=>Promise<RouteEntry['readerArticle']|null>;canRestore?:(entry:ActivityRoute)=>boolean}):Promise<ActivityRoute[]>{
 const result:ActivityRoute[]=[];
 for(const entry of entries){
  if(resolver.canRestore&&!resolver.canRestore(entry))break;
  if(entry.channelId&&!resolver.hasChannel(entry.channelId))break;
  if(entry.articleId){const article=await resolver.article(entry.articleId);if(!article)break;entry.readerArticle=article;}
  result.push(entry);
 }
 return result.length?result:[{page:'home'}];
}

export function captureActivityNavigation(...args:Parameters<typeof captureActivityNavigationImpl>) {return traceServiceWork("reader.captureActivity",()=>captureActivityNavigationImpl(...args));}
