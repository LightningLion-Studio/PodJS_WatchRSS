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
/** Consume known backups first, then re-resolve expired URLs. Never silently loop a failed source. */
export function createBiliPlaybackRetry(initial:BiliPlayUrl, resolve:()=>Promise<BiliPlayUrl>, title:string, headers:Record<string,string>) {
 let candidates=biliPlaybackCandidates(initial,title,headers), current=candidates.shift();
 const failed=new Set<string>();
 const key=(source:PlaybackSource)=>JSON.stringify([source.url,source.videoUrl,source.audioUrl]);
 return async ():Promise<PlaybackSource>=>{
  if(current)failed.add(key(current));
  let next=candidates.find(source=>!failed.has(key(source)));
  if(!next){candidates=biliPlaybackCandidates(await resolve(),title,headers);next=candidates.find(source=>!failed.has(key(source)));}
  if(!next)throw new Error("未取得新的可播放地址，请稍后重试");
  current=next;return next;
 };
}
