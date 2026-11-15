import {expect,test} from 'bun:test';
import {DouyinVideoSessionPool} from '../../src/ui/douyin/video-sessions.ts';

test('Douyin keeps one neighbour even when the native host offers independent frames and extra sessions',async()=>{
 const released:string[]=[];
 const pool=new DouyinVideoSessionPool({
  capabilities:async()=>({decoderLimit:3,maxSessions:4,independentKeyframes:true,keyframeCache:true,surfacePromotion:true,verticalTransition:true}),
  release:async(id:string)=>{released.push(id);return {sessionId:id,released:true};},
 } as any);
 expect(await pool.supportsPrewarm()).toBe(true);
 expect(pool.neighbourCapacity).toBe(1);
 await pool.warmNeighbourhood([async()=>{throw Error('must not decode distant frames');}]);
});
