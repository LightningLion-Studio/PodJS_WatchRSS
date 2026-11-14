import {kv} from '@podjs/framework/watch';
import type {RouteEntry} from '../../../src/ui/routes/types.ts';
import {DouyinPlaybackQueue} from '../../../src/douyin/playback-queue.ts';
import {douyinClient} from '../../../src/media-services.ts';
export function fixtureEntries():RouteEntry[]{
 const platform=kv.get<'douyin'|'bili'|'rss'>('dyback.platform')??'douyin';
 const items=Array.from({length:8},(_,i)=>({awemeId:`fixture-${i}`,description:`LOCAL FIXTURE ${i}`,playUrl:`fixture-${i%2}.mp4`,coverUrl:'',createdAtSeconds:0,authorId:'local',authorName:'LOCAL',likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:120000,variants:[]}));
 const playback={platform,immersive:platform==='douyin',awemeId:items[2].awemeId,title:items[2].description,url:items[2].playUrl,videoMime:'video/avc',videoWidth:480,videoHeight:270,digitalCrownVolume:true};
 // Local fixed-source queue, no feed fetch and no account data.
 const queue=platform==='douyin'?new DouyinPlaybackQueue(douyinClient,{items,selectedAwemeId:items[2].awemeId,hasMore:false,fixedSources:true}):undefined;
 return [{page:'home'},{page:'douyin',douyinRoute:{name:'entry'}},{page:'video',playback,queue,memory:{id:'r3',saved:{'player-scale':'expanded'},retained:{}}}];
}
