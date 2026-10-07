import type {CacheStats} from '@podjs/framework/cache';
import type {CacheBucket} from '../cache/policy.ts';
import type {BiliPreviewCache} from '../bili/preview.ts';
import type {DouyinPlaybackQueue} from '../douyin/playback-queue.ts';
import type {DouyinVideoSessionPool} from '../ui/douyin/video-sessions.ts';
export type SessionDiagnostics=Awaited<ReturnType<DouyinVideoSessionPool['diagnostics']>>;
export interface PlaybackCacheDiagnostics {managed?:CacheStats<CacheBucket>;preview?:ReturnType<BiliPreviewCache['diagnostics']>}
export type PlaybackQueueDiagnostics=ReturnType<DouyinPlaybackQueue['diagnostics']>;
const unavailable=(reason:string)=>`unavailable (${reason})`;
/** Restricted fields only: never stringify request headers, URLs, source digests or errors. */
export function playbackDiagnosticLines(cache:PlaybackCacheDiagnostics,queue:PlaybackQueueDiagnostics|undefined,sessions:SessionDiagnostics){
 const lines:string[]=[];
 if(cache.managed){const c=cache.managed;lines.push('ManagedCache='+JSON.stringify({bytes:c.bytes,limitBytes:c.limitBytes,bucketBytes:c.bucketBytes,pinnedPathCount:c.pinnedPaths.length,activeWorkers:c.activeWorkers,queuedRequests:c.queuedRequests}));
  lines.push('DL='+JSON.stringify({scope:'managed-file-workers',activeWorkers:c.activeWorkers,queuedRequests:c.queuedRequests,downloadHandles:c.downloadHandles,leasedPaths:c.jobs.length,wireBytes:'unavailable'}));
 }else{lines.push('ManagedCache='+unavailable('disk accounting failed or not attached'),'DL='+unavailable('managed download worker not attached'));}
 if(cache.preview)lines.push('M3='+JSON.stringify({scope:cache.preview.indexScope,records:cache.preview.records.length,completeRecords:cache.preview.records.filter(r=>r.complete).length,partialFileBytes:cache.preview.records.filter(r=>!r.complete).reduce((n,r)=>n+r.offset,0),indexedCompleteBytes:cache.preview.records.filter(r=>r.complete).reduce((n,r)=>n+r.size,0),activeJobs:cache.preview.jobs.filter(j=>j.active).length,queuedJobs:cache.preview.queuedJobs,clearing:cache.preview.clearing}));
 else lines.push('M3='+unavailable('Bili preview index not attached'));
 lines.push('DouyinPreviewDL='+unavailable('no native Douyin preview-download producer'), 'RAM='+unavailable('no native preview byte-array cache or measured allocator usage'));
 if(sessions){const c=sessions.capabilities;
  lines.push('VideoSessions='+JSON.stringify({generation:sessions.generation,standbyReady:sessions.standbyReady,standbyPreparing:sessions.standbyPreparing,...(c?{maxSessions:c.maxSessions,decoderLimit:c.decoderLimit,decoderInUse:c.decoderInUse,targetBufferBytesPerSession:c.targetBufferBytesPerSession,targetBufferBytesTotal:c.targetBufferBytesTotal}: {capabilities:'unavailable'})}));
  lines.push('Slots='+JSON.stringify(sessions.slots.map(slot=>({role:slot.role,sessionId:slot.sessionId,awemeId:slot.awemeId??'',bound:slot.bound,...(slot.state?{state:slot.state.state,positionMs:slot.state.positionMs,durationMs:slot.state.durationMs,width:slot.state.width,height:slot.state.height,prewarming:slot.state.prewarming,presented:slot.state.presented,hasRenderedFirstFrame:slot.state.hasRenderedFirstFrame,targetBufferBytes:slot.state.targetBufferBytes}:{state:slot.bound?'unavailable':'unbound'})}))));
 }else lines.push('VideoSessions='+unavailable('legacy player, unmounted owner or changed generation'),'Slots=unavailable');
 if(queue){lines.push('Queue='+JSON.stringify({index:queue.index,itemCount:queue.itemCount,hasMore:queue.hasMore,generation:queue.generation,previewGeneration:queue.previewGeneration}), 'Quarantined='+JSON.stringify({scope:'playback-queue-removal-set',awemeIds:queue.quarantinedAwemeIds,reason:'unavailable',failureCount:'unavailable',lastFailedAt:'unavailable'}));}
 else lines.push('Queue='+unavailable('no attached playback queue'),'Quarantined=unavailable');
 return lines;
}
