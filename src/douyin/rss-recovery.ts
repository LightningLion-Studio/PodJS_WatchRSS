import type { DouyinClient } from "./client.ts";
import type { PlaybackSource } from "../ui/VideoPlayerScreen.tsx";

/** RSS retries the same item; it must not discard it or enter the immersive queue. */
export class DouyinRssRecovery {
  private running=false;
  private attempted=false;
  constructor(private client:Pick<DouyinClient,"resolvePlayback"|"buildPlaybackHeaders">,private awemeId:string) {}
  async recover(source:PlaybackSource,isCurrent:()=>boolean,manual=false):Promise<PlaybackSource|undefined> {
    if(!isCurrent()||this.running||(!manual&&this.attempted))return;
    this.running=true;this.attempted=true;
    try {
      const result=await this.client.resolvePlayback(this.awemeId,{forceRefresh:true});
      if(!isCurrent())return;
      if(!result.ok)throw new Error(result.message);
      const headers=await this.client.buildPlaybackHeaders();
      if(!isCurrent())return;
      return {...source,url:result.data.playUrl,headers};
    } finally {this.running=false;}
  }
}
