import type { BiliPlayUrl } from "./bili/types.ts";
import type { PlaybackSource } from "./ui/VideoPlayerScreen.tsx";
const urls = (primary: string | undefined, backups: string[]) => [...new Set([primary, ...backups].map(url => url?.trim()).filter((url): url is string => !!url))];
export function biliPlaybackCandidates(source:BiliPlayUrl,title:string,headers:Record<string,string>):PlaybackSource[] {
 if(source.durl.length) return urls(source.durl[0]?.url, source.durl[0]?.backupUrl ?? []).map(url => ({url,headers,title}));
 const dash=source.dash;
 if(!dash?.video.length)return [];
 const supported=dash.video.filter(v=>v.codecId==null||v.codecId===7);
 const video=[...(supported.length?supported:dash.video)].sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0));
 const audio=[...dash.audio].sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0)).flatMap(a=>urls(a.baseUrl,a.backupUrl));
 return video.flatMap(v=>urls(v.baseUrl,v.backupUrl).flatMap<PlaybackSource>(videoUrl=>audio.length?audio.map(audioUrl=>({videoUrl,audioUrl,headers,title})): [{url:videoUrl,headers,title}]));
}
export function biliPlaybackSource(source:BiliPlayUrl,title:string,headers:Record<string,string>):PlaybackSource {
 const candidate=biliPlaybackCandidates(source,title,headers)[0];
 if(!candidate)throw new Error("未取得播放地址");return candidate;
}
export interface BiliPlaybackRetryOptions { manual?: boolean }
/** Automatic recovery is bounded; an explicit retry starts a fresh attempt, including unchanged URLs. */
export function createBiliPlaybackRetry(initial:BiliPlayUrl, resolve:()=>Promise<BiliPlayUrl>, title:string, headers:Record<string,string>, local?:()=>Promise<PlaybackSource|undefined>, initialSource?:PlaybackSource) {
 let candidates=biliPlaybackCandidates(initial,title,headers), current=initialSource??candidates.shift(), refreshed=false, localConsumed=false;
 const failed=new Set<string>();
 const key=(source:PlaybackSource)=>JSON.stringify([source.url,source.videoUrl,source.audioUrl]);
 let pending:Promise<PlaybackSource>|undefined;
 const choose=async({manual=false}:BiliPlaybackRetryOptions):Promise<PlaybackSource>=>{
  let resolutionError:unknown;
  if(manual){
   const known=current?[current,...candidates]:candidates;
   failed.clear();localConsumed=false;refreshed=true;
   // Refresh first, but a transient resolver failure must not prevent retrying
   // a known stream. A successful empty response still uses only checked cache.
   try{candidates=biliPlaybackCandidates(await resolve(),title,headers);}
   catch(error){resolutionError=error;candidates=known;}
  }else if(current)failed.add(key(current));
  let next=candidates.find(source=>!failed.has(key(source)));
  if(!next&&!refreshed){refreshed=true;try{candidates=biliPlaybackCandidates(await resolve(),title,headers);next=candidates.find(source=>!failed.has(key(source)));}catch(error){resolutionError=error;}}
  if(!next&&!localConsumed&&local){localConsumed=true;const cached=await local();if(cached&&!failed.has(key(cached)))next=cached;}
  if(!next&&resolutionError&&!local)throw resolutionError;
  if(!next)throw new Error("未取得新的可播放地址，请稍后重试");
  current=next;return next;
 };
 return (options:BiliPlaybackRetryOptions={}):Promise<PlaybackSource>=>{
  if(!pending)pending=choose(options).finally(()=>{pending=undefined;});
  return pending;
 };
}

/** Resolution failure or an empty remote result uses only a committed local preview. */
export async function resolveBiliPlaybackWithPreview(resolve:()=>Promise<BiliPlayUrl>,local:()=>Promise<PlaybackSource|undefined>,title:string,headers:Record<string,string>):Promise<{remote:BiliPlayUrl;source:PlaybackSource}> {
 try {const remote=await resolve();return {remote,source:biliPlaybackSource(remote,title,headers)};}
 catch(error){const source=await local();if(!source)throw error;return {remote:{durl:[],acceptQuality:[],acceptDescription:[]},source};}
}
