import type {PlaybackSource} from '../ui/VideoPlayerScreen.tsx';

/** Publishing a newly resolved URL must not retain a former DASH audio track,
 * preview error, or the exhausted experimental recovery deadline. */
export function freshVideoSource(previous:PlaybackSource,next:Partial<PlaybackSource>,positionMs:number):PlaybackSource {
  if(!next.url&&!next.videoUrl)throw Object.assign(new Error('未取得播放地址'),{code:'prepare_failed'});
  return {...previous,url:undefined,videoUrl:undefined,audioUrl:undefined,headers:undefined,expiresAtMs:undefined,videoMime:undefined,videoWidth:undefined,videoHeight:undefined,
    ...next,previewOnly:false,preparationError:undefined,recoveryDeadlineMs:undefined,
    bypassCache:true,resumePositionMs:Number.isFinite(positionMs)?Math.max(0,positionMs):0};
}
