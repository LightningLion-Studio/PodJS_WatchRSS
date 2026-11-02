import {VideoSessionPool} from '@podjs/framework/video-session-pool';
import type { PlaybackSource } from "../VideoPlayerScreen.tsx";
import type { DouyinItem } from "../../douyin/types.ts";

export {videoPagerDelta as douyinPagerDelta,VIDEO_PAGER_SNAP_POSITIONAL_THRESHOLD as DOUYIN_PAGER_SNAP_POSITIONAL_THRESHOLD,VIDEO_PAGER_MIN_FLING_VELOCITY as DOUYIN_PAGER_MIN_FLING_VELOCITY,VIDEO_PAGER_SETTLE_DURATION_MS as DOUYIN_PAGER_SETTLE_DURATION_MS,videoPagerProgress as douyinPagerProgress,shouldSettleVideoPager as shouldSettleDouyinPager,videoPagerSettleProgress as douyinPagerSettleProgress} from '@podjs/framework/video-paging';
export type DouyinPagerDirection = 'up'|'down';
export interface DouyinPreparedSource {key:string;source:PlaybackSource}

export function douyinDecoderProfile(item:DouyinItem,url=item.playUrl):Pick<PlaybackSource,"videoMime"|"videoWidth"|"videoHeight">{
  const variant=item.variants.find(candidate=>candidate.playUrl===url||candidate.playUrls?.includes(url));
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
  const code=String((error as {code?:unknown}|null)?.code??'');
  return /session_limit|decoder_(?:capacity|limit|unavailable)|resource_busy|resource_exhausted|too_many_sessions|session_(?:unavailable|unsupported)|capability_missing/i.test(code+' '+String(error));
}

/** Business metadata only; retained surface ownership lives in the framework. */
export class DouyinVideoSessionPool extends VideoSessionPool<DouyinPreparedSource> {
  override async diagnostics(){
    const value=await super.diagnostics();
    return value?{...value,slots:value.slots.map(slot=>({...slot,awemeId:slot.key&&/^[0-9]+$/.test(slot.key)?slot.key:undefined}))}:undefined;
  }
}
