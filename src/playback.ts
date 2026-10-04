import type { BiliPlayUrl } from "./bili/types.ts";
import type { PlaybackSource } from "./ui/VideoPlayerScreen.tsx";
export function biliPlaybackSource(source:BiliPlayUrl,title:string,headers:Record<string,string>):PlaybackSource {
 if(source.durl.length){
  const url=source.durl[0]?.url?.trim();
  if(!url)throw new Error("未取得播放地址");
  return {url,headers,title};
 }
 const dash=source.dash;
 if(dash?.video.length){
  const supported=dash.video.filter(v=>(v.codecId==null||v.codecId===7)&&!!v.baseUrl);
  const candidates=supported.length?supported:dash.video.filter(v=>!!v.baseUrl);
  const selected=[...candidates].sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0))[0];
  const audio=[...dash.audio].filter(a=>!!a.baseUrl).sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0))[0];
  if(!selected?.baseUrl)throw new Error("未找到可播放的视频流");
  return audio?.baseUrl?{videoUrl:selected.baseUrl,audioUrl:audio.baseUrl,headers,title}:{url:selected.baseUrl,headers,title};
 }
 throw new Error("未取得播放地址");
}
