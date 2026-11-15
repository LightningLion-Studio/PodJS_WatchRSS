import type {DouyinSavedPlaybackDiagnostic} from './saved-playback-diagnostics.ts';
import {douyinDecoderProfile} from '../ui/douyin/video-sessions.ts';
import {videoOptEnabled} from '../media/video-opt.ts';
import {DouyinPlaybackRecovery} from './playback-recovery.ts';
import {douyinPlaybackAudio} from './playback-selector.ts';
import type {DouyinItem} from './types.ts';
import type { DouyinClient } from "./client.ts";
import type { PlaybackSource } from "../ui/VideoPlayerScreen.tsx";

/** RSS retries the same item; it must not discard it or enter the immersive queue. */
export class DouyinRssRecovery {
  private policy?:DouyinPlaybackRecovery;
  private running=false;
  private attempted=false;
  private failedUrl?:string;
  constructor(private client:Pick<DouyinClient,"resolvePlayback"|"buildPlaybackHeaders">,private awemeId:string,private initial?:DouyinItem,private diagnostic?:DouyinSavedPlaybackDiagnostic) {}
  async reload(source:PlaybackSource,isCurrent:()=>boolean):Promise<PlaybackSource|undefined>{
    this.diagnostic?.recovery(true);
    const result=await this.client.resolvePlayback(this.awemeId,{forceRefresh:true,freshRequest:true,observeResolution:value=>this.diagnostic?.resolution('refresh',value)});
    if(!isCurrent())return;
    if(!result.ok){this.diagnostic?.recoveryError();throw Object.assign(new Error(result.message),{code:result.code});}
    const headers=await this.client.buildPlaybackHeaders();
    if(!isCurrent())return;
    this.diagnostic?.address('recovery',source.url,result.data.playUrl);
    return {...source,expiresAtMs:undefined,videoMime:undefined,videoWidth:undefined,videoHeight:undefined,...douyinDecoderProfile(result.data),url:result.data.playUrl,videoUrl:undefined,audioUrl:douyinPlaybackAudio(result.data),headers};
  }
  private async refresh(previousUrl?:string){
    const result=await this.client.resolvePlayback(this.awemeId,{forceRefresh:true,observeResolution:value=>this.diagnostic?.resolution('refresh',value)});
    if(result.ok)this.diagnostic?.address('recovery',previousUrl,result.data.playUrl);
    return result;
  }
  async recover(source:PlaybackSource,isCurrent:()=>boolean,manual=false,error?:unknown):Promise<PlaybackSource|undefined> {
    if(videoOptEnabled('recovery')){
      if(isCurrent()){this.failedUrl=source.url;this.diagnostic?.recovery(manual);}
      this.policy??=new DouyinPlaybackRecovery(this.initial??{awemeId:this.awemeId,playUrl:source.url??'',variants:[]},async()=>{const result=await this.refresh(this.failedUrl);if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,retryAfterMs:result.retryAfterMs});return result.data;});
      try{return await this.policy.recover(source,isCurrent,manual,error);}catch(value){this.diagnostic?.recoveryError();throw value;}
    }
    if(!isCurrent()||this.running||(!manual&&this.attempted))return;
    this.running=true;this.attempted=true;this.diagnostic?.recovery(manual);
    try {
      const result=await this.refresh(source.url);
      if(!isCurrent())return;
      if(!result.ok)throw new Error(result.message);
      const headers=await this.client.buildPlaybackHeaders();
      if(!isCurrent())return;
      return {...source,url:result.data.playUrl,audioUrl:douyinPlaybackAudio(result.data),headers};
    } catch(error){this.diagnostic?.recoveryError();throw error;} finally {this.running=false;}
  }
}
