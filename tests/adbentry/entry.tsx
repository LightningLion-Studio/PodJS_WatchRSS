import {startWatchRssApp} from '../../src/app-entry.tsx';
import {kv} from '@podjs/framework/watch';
import {secureStorage} from '@podjs/framework/services';
import {douyinClient} from '../../src/media-services.ts';
import {CURRENT_OOBE_VERSION,PRIVACY_POLICY_VERSION} from '../../src/onboarding/state.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
// Synthetic, isolated app only; never imported by src/main.tsx.
kv.set('watchrss.onboarding',{oobeSeenVersion:CURRENT_OOBE_VERSION,privacyPolicyAgreedVersion:PRIVACY_POLICY_VERSION});
for(const key of ['watchrss.transparency.initial_app_disclosure_v1','watchrss.transparency.douyin_disclosure_v1'])kv.set(key,true);
const items:DouyinItem[]=[0,1,2].map(index=>({awemeId:String(900000000000000000n+BigInt(index)),description:'ADBENTRY synthetic '+index,createdAtSeconds:0,authorId:'fixture',authorName:'Fixture',likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:'http://127.0.0.1:18876/video.mp4',durationMs:60000,variants:[{playUrl:'http://127.0.0.1:18876/video.mp4',codec:'h264',bitrate:120000,width:160,height:160}]}));
startWatchRssApp(async()=>{
 await secureStorage.set('douyin.cookie','sessionid=ADBENTRY_SYNTHETIC_ONLY');
 await douyinClient.saveRecentWindow(items,items[0].awemeId,null,false);
 console.log('ADBENTRY_FIXTURE_READY');
});
