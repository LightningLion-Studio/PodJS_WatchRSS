import {appLogger} from '../../logs/app-logger.ts';
import {logPlatformId} from '../../logs/fields.ts';
import {
  videoSessions,
  hostOperation,
  type HostOperation,
  type VideoBounds,
  type VideoFrameCapture,
  type VideoFrame,
  type VideoPrepare,
  type VideoSessionCapabilities,
  type VideoSessionState,
  type VideoSessionTransitionState,
  type VideoState,
} from "@podjs/framework/services";
import type { PlaybackSource } from "../VideoPlayerScreen.tsx";
import type { DouyinItem } from "../../douyin/types.ts";

export const DOUYIN_PAGER_SNAP_POSITIONAL_THRESHOLD = .18;
// Compose PagerDefaults uses the platform minimum fling velocity before the
// positional threshold. PocketJS velocities are logical px/s (dp/s here).
export const DOUYIN_PAGER_MIN_FLING_VELOCITY = 125;
export const DOUYIN_PAGER_SETTLE_DURATION_MS = 220;

export type DouyinPagerDirection = "up" | "down";
export interface DouyinPreparedSource { key:string; source:PlaybackSource }
type VideoDecoderProfile={videoMime?:string;videoWidth?:number;videoHeight?:number};

export function douyinDecoderProfile(item:DouyinItem,url=item.playUrl):Pick<PlaybackSource,"videoMime"|"videoWidth"|"videoHeight">{
  const variant=item.variants.find(candidate=>candidate.playUrl===url);
  if(!variant)return {};
  return {
    ...(variant.codec==="h264"?{videoMime:"video/avc"}:variant.codec==="h265"?{videoMime:"video/hevc"}:{}),
    ...(variant.width>0?{videoWidth:variant.width}:{}),
    ...(variant.height>0?{videoHeight:variant.height}:{}),
  };
}

export function shouldUseDouyinVideoSessions(source:PlaybackSource,capable:boolean):boolean {
  return capable&&source.platform==="douyin"&&source.immersive===true;
}

export function shouldFallbackFromVideoSessions(error:unknown):boolean {
  return !/cancel|stale/i.test(String(error));
}

export function douyinPagerProgress(distanceY:number,height:number):number {
  return height>0?Math.max(0,Math.min(1,Math.abs(distanceY)/height)):0;
}

export function shouldSettleDouyinPager(progress:number,velocityY:number,direction:DouyinPagerDirection):boolean {
  if(Math.abs(velocityY)>=DOUYIN_PAGER_MIN_FLING_VELOCITY)return direction==="up"?velocityY<0:velocityY>0;
  return progress>=DOUYIN_PAGER_SNAP_POSITIONAL_THRESHOLD;
}

export function douyinPagerSettleProgress(from:number,to:0|1,elapsedMs:number):number {
  const t=Math.max(0,Math.min(1,elapsedMs/DOUYIN_PAGER_SETTLE_DURATION_MS));
  const eased=1-Math.pow(1-t,3);
  return from+(to-from)*eased;
}

interface SessionPort {
  captureFrame?(sessionId:string,options:VideoFrameCapture):Promise<VideoFrame>;
  capabilities(profile?:VideoDecoderProfile):Promise<VideoSessionCapabilities>;
  prepare(options:Parameters<typeof videoSessions.prepare>[0]):HostOperation<VideoSessionState>;
  play(sessionId:string):Promise<VideoSessionState>;
  pause(sessionId:string):Promise<VideoSessionState>;
  seek(sessionId:string,positionMs:number):Promise<VideoSessionState>;
  stop(sessionId:string):Promise<VideoSessionState>;
  release(sessionId:string):Promise<{sessionId:string;released:boolean}>;
  setBounds(sessionId:string,bounds:VideoBounds):Promise<VideoSessionState>;
  state(sessionId:string):Promise<VideoSessionState>;
  setTransform(sessionId:string,transform:{rotationDeg?:number;scaleMode?:"standard"|"expanded"|"shrunk";panX?:number;panY?:number}):Promise<VideoSessionState>;
  setVolume(sessionId:string,volume:number):Promise<VideoSessionState>;
  setLoop(sessionId:string,loop:boolean):Promise<VideoSessionState>;
  promote(sessionId:string,options:{replaceSessionId?:string;bounds?:VideoBounds;autoplay?:boolean}):Promise<VideoSessionState>;
  transition(options:{fromSessionId:string;toSessionId:string;progress:number;direction:DouyinPagerDirection;bounds?:VideoBounds}):Promise<VideoSessionTransitionState>;
}

const defaultSessionPort:SessionPort={
  ...videoSessions,
  capabilities:(profile={})=>hostOperation<VideoSessionCapabilities>("video.session.capabilities",profile).result,
};

let nextPoolId=1;
const state=(value:VideoSessionState):VideoState=>({
  ok:value.ok,state:value.state,positionMs:value.positionMs,durationMs:value.durationMs,completedLoops:value.completedLoops,loop:value.loop,
  width:value.width,height:value.height,volume:value.volume,volumeMax:15,
  sourceGeneration:value.sourceGeneration,errorCode:value.errorCode,hasRenderedFirstFrame:value.hasRenderedFirstFrame,
});

/** Two fixed host slots. Promotion swaps their roles, then the retired slot is
 * reused for the next forward prewarm, matching the native two-player plan. */
export class DouyinVideoSessionPool {
  private loop=false;
  private activeId:string;
  private standbyId:string;
  private activeKey:string|undefined;
  private standby:DouyinPreparedSource|undefined;
  private standbyReady=false;
  private standbyPrepare:HostOperation<VideoSessionState>|undefined;
  private generation=0;
  private transitionRunning:Promise<void>|undefined;
  private latestTransition:{progress:number;direction:DouyinPagerDirection;bounds:VideoBounds}|undefined;

  constructor(private readonly port:SessionPort=defaultSessionPort){
    const id=nextPoolId++;
    this.activeId=`dy${id}a`;this.standbyId=`dy${id}b`;
  }

  /** On-demand host observations, independent of renderer diagnostics and playback scheduling. */
  async diagnostics(){
    const generation=this.generation,activeId=this.activeId,standbyId=this.standbyId;
    const slots=[{role:'active',sessionId:activeId,awemeId:this.activeKey,bound:!!this.activeKey},
      {role:'standby',sessionId:standbyId,awemeId:this.standby?.source.awemeId,bound:!!this.standby}];
    const [capabilities,...states]=await Promise.allSettled([this.port.capabilities(),...slots.map(slot=>slot.bound?this.port.state(slot.sessionId):Promise.resolve(undefined))]);
    if(generation!==this.generation||activeId!==this.activeId||standbyId!==this.standbyId)return undefined;
    return {capabilities:capabilities.status==='fulfilled'?capabilities.value as VideoSessionCapabilities:undefined,
      generation,standbyReady:this.standbyReady,standbyPreparing:!!this.standbyPrepare,
      slots:slots.map((slot,i)=>({...slot,awemeId:slot.awemeId&&/^[0-9]+$/.test(slot.awemeId)?slot.awemeId:undefined,
        state:states[i]?.status==='fulfilled'?states[i].value as VideoSessionState|undefined:undefined})),
    };
  }

  async supportsPrewarm(profile:VideoDecoderProfile={}):Promise<boolean>{
    const capability=await this.port.capabilities(profile);
    return capability.decoderLimit>=2&&capability.surfacePromotion&&capability.verticalTransition;
  }

  prepare(source:DouyinPreparedSource,options:VideoPrepare):HostOperation<VideoState>{
    const own=++this.generation;
    this.loop=options.loop===true;
    this.activeKey=source.key;this.standby=undefined;this.standbyReady=false;
    this.standbyPrepare?.cancel();this.standbyPrepare=undefined;
    void this.port.release(this.standbyId).catch(()=>{});
    const operation=this.port.prepare({...options,sessionId:this.activeId,prewarm:false,autoplay:false});
    return {cancel:()=>operation.cancel(),result:operation.result.then(value=>{
      if(own!==this.generation)throw new Error("stale video session preparation");
      return this.syncLoop(this.activeId).then(state);
    })};
  }

  async prewarm(source:DouyinPreparedSource,options:VideoPrepare):Promise<VideoState>{
    if(source.key===this.activeKey)return this.state();
    if(this.standby?.key===source.key&&this.standbyReady)return this.port.state(this.standbyId).then(state);
    const own=++this.generation;
    appLogger.d("DouyinImmersive",`TEST_EVENT lookahead_prewarm_start awemeId=${logPlatformId(source.source.awemeId)} slot=${this.standbyId.endsWith("a")?"Primary":"Secondary"}`);
    this.standbyPrepare?.cancel();this.standby=source;this.standbyReady=false;
    // The host silences every prewarm internally while retaining this audible
    // volume for promotion. Passing muted=true would make the promoted slot
    // remain silent.
    const operation=this.port.prepare({...options,loop:this.loop,sessionId:this.standbyId,prewarm:true,autoplay:false,muted:false});
    this.standbyPrepare=operation;
    try{
      const value=await operation.result;
      if(own!==this.generation||this.standby?.key!==source.key)throw new Error("stale video session prewarm");
      while(true){
        const loop=this.loop;
        await this.port.setLoop(this.standbyId,loop);
        if(own!==this.generation||this.standby?.key!==source.key)throw new Error("stale video session prewarm");
        // Check and publish readiness in the same turn: a toggle between a
        // nested async helper's return and this continuation must not be lost.
        if(loop===this.loop){this.standbyReady=value.hasRenderedFirstFrame;return state(value);}
      }
    }finally{if(this.standbyPrepare===operation)this.standbyPrepare=undefined;}
  }

  captureFrame(options:VideoFrameCapture){if(!this.port.captureFrame)return Promise.reject(Error('frame_capture_unavailable'));return this.port.captureFrame(this.activeId,options);}
  invalidateStandby(key:string){if(this.standby?.key!==key)return;this.generation++;this.standbyPrepare?.cancel();this.standbyPrepare=undefined;this.standby=undefined;this.standbyReady=false;void this.port.release(this.standbyId).catch(()=>{});}
  hasStandby(key?:string):boolean{return this.standbyReady&&!!key&&this.standby?.key===key;}
  standbySource():DouyinPreparedSource|undefined{return this.standbyReady?this.standby:undefined;}

  async transition(progress:number,direction:DouyinPagerDirection,bounds:VideoBounds):Promise<void>{
    if(!this.standbyReady||!this.standby)throw new Error("video session target is not prewarmed");
    this.latestTransition={progress:Math.max(0,Math.min(1,progress)),direction,bounds};
    if(this.transitionRunning)return this.transitionRunning;
    this.transitionRunning=(async()=>{
      while(this.latestTransition){
        const next=this.latestTransition;this.latestTransition=undefined;
        await this.port.transition({fromSessionId:this.activeId,toSessionId:this.standbyId,...next});
      }
    })();
    try{await this.transitionRunning;}finally{this.transitionRunning=undefined;}
  }

  async promote(direction:DouyinPagerDirection,bounds:VideoBounds,autoplay=true):Promise<{source:DouyinPreparedSource;state:VideoState}>{
    const target=this.standby;if(!target||!this.standbyReady)throw new Error("video session target is not prewarmed");
    await this.transition(1,direction,bounds);
    const promoted=await this.port.promote(this.standbyId,{replaceSessionId:this.activeId,bounds,autoplay});
    [this.activeId,this.standbyId]=[this.standbyId,this.activeId];
    appLogger.d("DouyinImmersive",`promote slot=${this.activeId.endsWith("a")?"Primary":"Secondary"} awemeId=${logPlatformId(target.source.awemeId)}`);
    this.activeKey=target.key;this.standby=undefined;this.standbyReady=false;this.generation++;
    return {source:target,state:state(promoted)};
  }

  private async syncLoop(id:string):Promise<VideoSessionState>{
    while(true){const loop=this.loop,value=await this.port.setLoop(id,loop);if(loop===this.loop)return value;}
  }

  async setLoop(loop:boolean):Promise<void>{
    this.loop=loop;
    await Promise.all([...(this.activeKey?[this.syncLoop(this.activeId)]:[]),...(this.standbyReady?[this.syncLoop(this.standbyId)]:[])]);
  }

  play():Promise<VideoState>{return this.port.play(this.activeId).then(state);}
  pause():Promise<VideoState>{return this.port.pause(this.activeId).then(state);}
  seek(positionMs:number):Promise<VideoState>{return this.port.seek(this.activeId,positionMs).then(state);}
  stop():Promise<VideoState>{return this.port.stop(this.activeId).then(state);}
  setBounds(bounds:VideoBounds):Promise<VideoState>{return this.port.setBounds(this.activeId,bounds).then(state);}
  state():Promise<VideoState>{return this.port.state(this.activeId).then(state);}
  setTransform(transform:{rotationDeg?:number;scaleMode?:"standard"|"expanded"|"shrunk";panX?:number;panY?:number}):Promise<VideoState>{return this.port.setTransform(this.activeId,transform).then(state);}
  setVolume(volume:number):Promise<VideoState>{return this.port.setVolume(this.activeId,volume).then(state);}

  async releaseAll():Promise<void>{
    this.generation++;this.latestTransition=undefined;this.standbyPrepare?.cancel();this.standbyPrepare=undefined;
    this.activeKey=undefined;this.standby=undefined;this.standbyReady=false;
    await Promise.allSettled([this.port.release(this.activeId),this.port.release(this.standbyId)]);
  }
}
