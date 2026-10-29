import {videoOptEnabled} from '../media/video-opt.ts';
import {DouyinPlaybackRecovery} from './playback-recovery.ts';
import type {DouyinItem} from './types.ts';
import type { DouyinClient } from "./client.ts";
import type { PlaybackSource } from "../ui/VideoPlayerScreen.tsx";

/** RSS retries the same item; it must not discard it or enter the immersive queue. */
export class DouyinRssRecovery {
  private policy?:DouyinPlaybackRecovery;
  private running=false;
  private attempted=false;
  constructor(private client:Pick<DouyinClient,"resolvePlayback"|"buildPlaybackHeaders">,private awemeId:string,private initial?:DouyinItem) {}
  async recover(source:PlaybackSource,isCurrent:()=>boolean,manual=false,error?:unknown):Promise<PlaybackSource|undefined> {
    if(videoOptEnabled('recovery')){
      this.policy??=new DouyinPlaybackRecovery(this.initial??{awemeId:this.awemeId,playUrl:source.url??'',variants:[]},async()=>{const result=await this.client.resolvePlayback(this.awemeId,{forceRefresh:true});if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,retryAfterMs:result.retryAfterMs});return result.data;});
      return this.policy.recover(source,isCurrent,manual,error);
    }
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
