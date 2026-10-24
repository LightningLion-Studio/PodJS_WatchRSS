import {expect,mock,test} from 'bun:test';
const events:any[]=[],emitted:any[]=[];
(globalThis as any).pod={capabilities:()=>JSON.stringify(['host.lifecycle','media.video.sessions']),takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,emit:(line:string)=>emitted.push(JSON.parse(line))};
mock.module('@pocketjs/framework/gesture',()=>({cancelActiveTouches(){}}));
mock.module('@pocketjs/framework/input',()=>({dispatchAccessibilityAction(){}}));
mock.module('@pocketjs/framework/services',()=>({registerServicePump(){}}));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {DouyinVideoSessionPool}=await import('../src/ui/douyin/video-sessions.ts');
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const caps={capability:'media.video.sessions',decoderLimit:2,maxSessions:2,decoderInUse:1,targetBufferBytesPerSession:6291456,targetBufferBytesTotal:12582912,surfacePromotion:true,verticalTransition:true};
const reply=async(req:any,value:any)=>{events.push({t:'service.result',id:req.id,ok:true,value});__pumpPodEvents();await tick();};
test('production pool constructor routes capability, prepare and diagnostic state through the real services bridge',async()=>{
 const pool=new DouyinVideoSessionPool();const support=pool.supportsPrewarm();await tick();expect(emitted.at(-1).method).toBe('video.session.capabilities');await reply(emitted.at(-1),caps);expect(await support).toBe(true);
 const operation=pool.prepare({key:'101',source:{awemeId:'101',title:'fixture',platform:'douyin'}},{url:'https://example.test/fixture'} as any);await tick();const prepare=emitted.at(-1),id=prepare.args.sessionId;expect(prepare.method).toBe('video.session.prepare');const state={ok:true,sessionId:id,state:'ready',positionMs:0,durationMs:100,width:10,height:20,muted:false,volume:1,prewarming:false,presented:true,hasRenderedFirstFrame:true,targetBufferBytes:6291456};await reply(emitted.at(-2),{released:true});await reply(prepare,state);expect(emitted.at(-1).method).toBe('video.session.setLoop');await reply(emitted.at(-1),state);await operation.result;
 const diag=pool.diagnostics();await tick();const requests=emitted.slice(-2);expect(requests.map(r=>r.method)).toEqual(['video.session.capabilities','video.session.state']);await reply(requests[0],caps);await reply(requests[1],state);const d=await diag;expect(d?.slots[0]?.awemeId).toBe('101');expect(d?.slots[0]?.state?.targetBufferBytes).toBe(6291456);expect(d?.capabilities?.decoderInUse).toBe(1);
});
