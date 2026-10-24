import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue';
import {test,expect} from 'bun:test';
import {DouyinPrefetchResults} from '../../src/douyin/prefetch-results';
import {framePreviewPath} from '../../src/douyin/frame-preview';
const binding=(generation=1)=>({id:'item',itemToken:'opaque'+generation,generation,uri:'proxy',url:'private'});
const failure=(generation=1,status=403)=>({itemToken:'opaque'+generation,generation,result:'failure' as const,httpStatus:status,category:status===403?'http_403' as const:'transport' as const});
test('prefetch current 403 refreshes once, stale URL/window failures are ignored, repeated neighbour failure quarantines',()=>{
 const p=new DouyinPrefetchResults(()=>123);p.bind(binding());expect(p.result(failure(),()=>false)?.action).toBe('refresh');
 p.begin();p.bind(binding(2));expect(p.result(failure(),()=>false)).toBeUndefined();expect(p.result(failure(2),()=>false)?.action).toBe('quarantine');
 expect(p.snapshot()).toEqual([{id:'item',count:2,consecutive:2,reason:'http_403',lastFailureAt:123,generation:2}]);
 const restored=new DouyinPrefetchResults(()=>456,p.snapshot());expect(restored.snapshot()[0]!.count).toBe(2);
});
test('prefetch cannot auto-isolate foreground, even repeated transport or 403 failures',()=>{
 const p=new DouyinPrefetchResults();p.bind(binding());for(let i=0;i<4;i++)expect(p.result(failure(1,0),()=>true)?.action).toBe('none');expect(p.result(failure(),()=>true)?.action).toBe('refresh');expect(p.result(failure(),()=>true)?.action).toBe('none');
});
test('actual frame preview is entry bound and distinct from playable bytes or cover cache',()=>{
 const preview={entryId:'a',frame:{available:true as const,kind:'actual_frame' as const,path:'video-frames/a.jpg',width:10,height:10,positionMs:42,capturedAt:1,capturedGeneration:5}};
 expect(framePreviewPath(preview,'a')).toBe('video-frames/a.jpg');expect(framePreviewPath(preview,'b')).toBeUndefined();expect(framePreviewPath(undefined,undefined)).toBeUndefined();
});

test('prefetch removal before the selected item fences an in-flight previous navigation rather than overwriting a shifted slot',async()=>{
 const item=(id:string)=>({awemeId:id,playUrl:'https://video/'+id,variants:[]}) as any;let resolve!:(value:any)=>void;
 const queue=new DouyinPlaybackQueue({resolvePlayback:()=>new Promise(r=>resolve=r)} as any,{items:['a','b','c'].map(item),selectedAwemeId:'c'});
 const previous=queue.previous();await Promise.resolve();expect(queue.quarantinePrefetch('a')).toBe(true);resolve({ok:true,data:item('b')});expect(await previous).toMatchObject({ok:false,code:'CANCELLED'});
 expect(queue.snapshot()).toMatchObject({index:1,item:{awemeId:'c'}});expect(queue.snapshot().playlist.map(item=>item.awemeId)).toEqual(['b','c']);
});
