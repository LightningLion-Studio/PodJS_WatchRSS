import {expect,test} from 'bun:test';
import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue.ts';
import type {DouyinClient} from '../../src/douyin/client.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const item=(id:number):DouyinItem=>({awemeId:String(id),description:'item '+id,authorName:'author',authorId:'author',createdAtSeconds:0,likeCount:1,commentCount:0,shareCount:0,collectCount:0,durationMs:10,playUrl:'https://fixture/'+id,variants:[{playUrl:'https://fixture/'+id,codec:'h264',width:480,height:640,bitrate:1}]});
test('blocked storage retains the latest queue/recent snapshots while every viewed item reaches ordered history',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),history:string[]=[],seen:string[]=[],snapshots:{kind:string;id:string}[]=[];let next=12;
 const client={resolvePlayback:async(_id:string,o:{feedItem:DouyinItem})=>({ok:true,data:o.feedItem}),
  fetchFeedPage:async()=>({ok:true,data:{items:Array.from({length:12},()=>item(next++)),nextCursor:String(next),hasMore:true}}),
  recordPresented:async(x:DouyinItem)=>{await gate;seen.push(x.awemeId);},
  recordHistory:async(x:DouyinItem)=>{expect(x.variants).toEqual([]);history.push(x.awemeId);},
  saveRecentWindow:async(_items:DouyinItem[],id:string)=>{await gate;snapshots.push({kind:'recent',id});},
  savePlaybackQueue:async(_items:DouyinItem[],id:string)=>{await gate;snapshots.push({kind:'queue',id});},
 }as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:12},(_,i)=>item(i)),selectedAwemeId:'0',hasMore:true});
 const writes:Promise<void>[]=[];
 for(let i=0;i<200;i++){if(i)expect((await q.next()).ok).toBe(true);await q.fillAhead(16);writes.push(q.settled());writes.push(q.persist());}
 expect(q.memoryStats().pendingSnapshots).toBeLessThanOrEqual(2);expect(q.memoryStats().activeSnapshots).toBe(1);
 release();await Promise.all(writes);
 expect(history).toEqual(Array.from({length:200},(_,i)=>String(i)));expect(seen).toEqual(history);
 expect(snapshots.filter(x=>x.kind==='queue').at(-1)?.id).toBe('199');expect(snapshots.filter(x=>x.kind==='recent').at(-1)?.id).toBe('199');
 expect(snapshots.length).toBeLessThanOrEqual(3);expect(q.memoryStats().pendingSnapshots).toBe(0);
});
test('coalesced snapshot failures reject all covered callers and a later save can succeed',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
 const client={savePlaybackQueue:async()=>{if(++calls===1)await gate;if(calls===2)throw Error('storage unavailable');}}as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:[item(1),item(2)],selectedAwemeId:'1',hasMore:false});
 const first=q.persist();q.commitPreview('2');const second=q.persist(),third=q.persist();
 const outcomes=Promise.allSettled([first,second,third]);release();expect((await outcomes).map(x=>x.status)).toEqual(['fulfilled','rejected','rejected']);
 await q.persist();expect(calls).toBe(3);
});
