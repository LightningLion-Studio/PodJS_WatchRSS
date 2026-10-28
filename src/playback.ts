import {playbackFailure} from './media/playback-failure.ts';
import {PlaybackRecoveryBudget,mediaSourceExpiry} from '@podjs/framework/media-policy';
import * as services from '@podjs/framework/services';
import type { BiliPlayUrl } from "./bili/types.ts";
import type { PlaybackSource } from "./ui/VideoPlayerScreen.tsx";
const urls = (primary: string | undefined, backups: string[]) => [...new Set([primary, ...backups].map(url => url?.trim()).filter((url): url is string => !!url))];
export function biliPlaybackCandidates(source:BiliPlayUrl,title:string,headers:Record<string,string>):PlaybackSource[] {
 if(source.durl.length) return urls(source.durl[0]?.url, source.durl[0]?.backupUrl ?? []).slice(0,16).map(url => ({url,headers,title}));
 const dash=source.dash;
 if(!dash?.video.length)return [];
 const supported=dash.video.filter(v=>v.codecId==null||v.codecId===7);
 const video=[...supported].sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0));
 const audio=[...dash.audio].sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0)).flatMap(a=>urls(a.baseUrl,a.backupUrl));
 const candidates:PlaybackSource[]=[];
 for(const v of video)for(const videoUrl of urls(v.baseUrl,v.backupUrl))for(const audioUrl of audio.length?audio:[undefined]){
  candidates.push(audioUrl?{videoUrl,audioUrl,headers,title}:{url:videoUrl,headers,title});
  if(candidates.length>=16)return candidates;
 }
 return candidates;
}
export function biliPlaybackSource(source:BiliPlayUrl,title:string,headers:Record<string,string>):PlaybackSource {
 const candidate=biliPlaybackCandidates(source,title,headers)[0];
 if(!candidate)throw new Error("未取得播放地址");return candidate;
}
export interface BiliPlaybackRetryOptions { manual?: boolean; error?:unknown }
/** Automatic recovery is bounded; an explicit retry starts a fresh attempt, including unchanged URLs. */
export function createBiliPlaybackRetry(initial:BiliPlayUrl, resolve:()=>Promise<BiliPlayUrl>, title:string, headers:Record<string,string>, local?:()=>Promise<PlaybackSource|undefined>, initialSource?:PlaybackSource, policy:{enabled?:boolean;networkEpoch?:()=>number;now?:()=>number}={}) {
 const now=policy.now??Date.now,budget=new PlaybackRecoveryBudget(now);let epoch=policy.networkEpoch?.();
 const fresh=(source:BiliPlayUrl)=>biliPlaybackCandidates(source,title,headers).filter(candidate=>!policy.enabled||mediaSourceExpiry([candidate.url??candidate.videoUrl??'',candidate.audioUrl??''],now())>now()).slice(0,16);
 let candidates=fresh(initial), current=initialSource??candidates.shift(), refreshed=false, localConsumed=false;
 const failed=new Set<string>();
 const key=(source:PlaybackSource)=>JSON.stringify([source.url,source.videoUrl,source.audioUrl]);
 let pending:Promise<PlaybackSource>|undefined;
 const choose=async({manual=false,error}:BiliPlaybackRetryOptions):Promise<PlaybackSource>=>{
  let resolutionError:unknown;
  if(policy.enabled){
   if(['restricted','decode'].includes(playbackFailure(error)))throw new Error('playback_recovery_not_retryable');
   if(manual)budget.reset();
   budget.claim();
   if(epoch!==policy.networkEpoch?.()){epoch=policy.networkEpoch?.();candidates=[];}
   if(playbackFailure(error)==='expired')candidates=[];
  }
  const resolveFresh=async()=>{const network=policy.networkEpoch?.();const value=await (policy.enabled?budget.run(resolve,services.delay):resolve());if(policy.enabled&&network!==policy.networkEpoch?.())throw new Error('playback_network_changed');return value;};
  if(manual){
   const known=current?[current,...candidates]:candidates;
   failed.clear();localConsumed=false;refreshed=true;
   // Refresh first, but a transient resolver failure must not prevent retrying
   // a known stream. A successful empty response still uses only checked cache.
   try{candidates=fresh(await resolveFresh());}
   catch(error){resolutionError=error;candidates=policy.enabled&&(['restricted','decode'].includes(playbackFailure(error))||String(error).includes('playback_network_changed'))?[]:known;}
  }else if(current)failed.add(key(current));
  const usable=(source:PlaybackSource)=>!failed.has(key(source))&&(!policy.enabled||mediaSourceExpiry([source.url??source.videoUrl??'',source.audioUrl??''],now())>now());
  let next=candidates.find(usable);
  if(!next&&!refreshed){refreshed=true;try{candidates=fresh(await resolveFresh());next=candidates.find(usable);}catch(error){resolutionError=error;}}
  if(!next&&!localConsumed&&local){localConsumed=true;const cached=await (policy.enabled?budget.run(local,services.delay):local());if(cached&&!failed.has(key(cached)))next=cached;}
  if(!next&&resolutionError&&!local)throw resolutionError;
  if(!next)throw new Error("未取得新的可播放地址，请稍后重试");
  if(policy.enabled)budget.check();
  current=policy.enabled?{...next,recoveryDeadlineMs:now()+budget.remaining()}:next;return current;
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
