import {expect,test} from 'bun:test';
import {douyinPlaybackAddresses} from '../../src/douyin/media-expiry.ts';
import {douyinReloadPlan} from '../../src/douyin/reload-rules.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';

type Input = Parameters<typeof douyinReloadPlan>[0];
type Plan = ReturnType<typeof douyinReloadPlan>;
const cases: {name:string;input:Input;expected:Plan}[] = [
  {name:'native expiry before the first frame',input:{cause:{code:'source_expired'}},
    expected:{reason:'source_expired',mode:'detail',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'explicit expiry after a frame',input:{expired:true,firstFrame:true},
    expected:{reason:'source_expired',mode:'feed',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'detail timeout retains native expiry',input:{cause:{code:'timeout'},previousReason:'source_expired',endpoint:'feed'},
    expected:{reason:'source_expired',mode:'feed',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'detail 429 retains expiry',input:{cause:{code:'RATE_LIMITED'},previousReason:'source_expired',endpoint:'feed'},
    expected:{reason:'source_expired',mode:'feed',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'detail 429 retains an ordinary reason',input:{cause:{code:'RATE_LIMITED'},previousReason:'unknown',endpoint:'feed'},
    expected:{reason:'unknown',mode:'feed',requireFreshAddress:false,reuseSavedSource:false}},
  {name:'buffered stall can refresh the same valid address',input:{firstFrame:true,cause:{code:'not_ready'}},
    expected:{reason:'not_ready',mode:'feed',requireFreshAddress:false,reuseSavedSource:false}},
  {name:'saved stall can reprepare its current source',input:{firstFrame:true,saved:true,cause:{code:'not_ready'}},
    expected:{reason:'not_ready',mode:'feed',requireFreshAddress:false,reuseSavedSource:true}},
  {name:'expired saved stall still needs detail',input:{firstFrame:true,saved:true,cause:{code:'not_ready'},expired:true},
    expected:{reason:'source_expired',mode:'detail',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'reconnect can keep the same address',input:{firstFrame:true,cause:{code:'network_error'}},
    expected:{reason:'transport',mode:'feed',requireFreshAddress:false,reuseSavedSource:false}},
  {name:'saved reconnect can reprepare its current source',input:{firstFrame:true,saved:true,cause:{code:'network_error'}},
    expected:{reason:'transport',mode:'feed',requireFreshAddress:false,reuseSavedSource:true}},
  {name:'manual retry without a recorded reason prefers feed',input:{manual:true},
    expected:{reason:'unknown',mode:'feed',requireFreshAddress:false,reuseSavedSource:false}},
  {name:'manual retry retains the expiry requirement',input:{manual:true,previousReason:'source_expired'},
    expected:{reason:'source_expired',mode:'feed',requireFreshAddress:true,reuseSavedSource:false}},
  {name:'the default cause is unknown',input:{},
    expected:{reason:'unknown',mode:'feed',requireFreshAddress:false,reuseSavedSource:false}},
];
for(const {name,input,expected} of cases)test(`Douyin reload contract: ${name}`,()=>{
  expect(douyinReloadPlan(input)).toEqual(expected);
});

for(const expired of ['primary','mirror','audio'] as const)test(`Douyin expiry contract: expired ${expired}`,()=>{
  const now=1_800_000_000_000, past=1_799_999_000, future=1_800_010_000;
  const main=`https://fixture.invalid/main?expires=${expired==='primary'?past:future}`;
  const mirror=`https://fixture.invalid/mirror?expires=${expired==='mirror'?past:future}`;
  const audio=`https://fixture.invalid/audio?expires=${expired==='audio'?past:future}`;
  const item:DouyinItem={
    awemeId:'selected',description:'',authorName:'',authorId:'',createdAtSeconds:0,durationMs:0,
    likeCount:0,commentCount:0,collectCount:0,shareCount:0,playUrl:main,
    variants:[{playUrl:main,playUrls:[main,mirror],audioUrl:audio,format:'dash',codec:'h264',width:480,height:854,bitrate:200_000}],
  };
  const deadlines=douyinPlaybackAddresses(item);
  expect(deadlines.expiresAtMs).toBeLessThan(now);
  if(expired==='mirror')expect(deadlines.directExpiresAtMs).toBeGreaterThan(now);
  else expect(deadlines.directExpiresAtMs).toBeLessThan(now);
});
