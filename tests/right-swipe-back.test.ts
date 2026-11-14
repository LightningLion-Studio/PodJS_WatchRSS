import {afterEach,expect,test} from 'bun:test';
import {attachGesture,__runGestures,resetGestures} from '@pocketjs/framework/gesture';
import {__packTouch,__resetTouches,__setTouches} from '../node_modules/@pocketjs/framework/framework/src/touch.ts';
import {__advanceClock,resetClock} from '../node_modules/@pocketjs/framework/framework/src/clock.ts';
import {BackMotion} from '@podjs/framework/navigation';
import {rightSwipeBack} from '../src/navigation/right-swipe-back.ts';
const region={rect:()=>({x:0,y:0,w:233,h:233})};
function pump(x?:number,y=100){__advanceClock();__setTouches(x===undefined?[]:[__packTouch(1,x,y)]);__runGestures();}
afterEach(()=>{resetGestures();__resetTouches();resetClock();});
function back(){const motion=new BackMotion(233);let started=0;attachGesture(rightSwipeBack(region,{
 start(dx){started++;motion.begin(dx);},move:dx=>motion.move(dx),end:v=>motion.release(v,1000),cancel:()=>motion.release(0,1000,true),
}));return {motion,started:()=>started};}
test('DYBACK right swipe commits; short swipe cancels; reversal cancels',()=>{
 for(const points of [[30,80,150],[30,35,40],[30,150,35]]){
  const f=back();for(const x of points)pump(x);pump();
  expect(f.motion.tick(2000)).toBe(points[2]===150?'commit':'cancel');
  resetGestures();__resetTouches();
 }
});
for(const order of ['before','after'] as const)test(`DYBACK opposite detail gesture registered ${order} retains contact`,()=>{
 let ended=0;const detail=()=>attachGesture({region,axis:'x',onPanStart(){},onPanEnd(){ended++;}});
 if(order==='before')detail();const f=back();if(order==='after')detail();
 pump(180);pump(140);pump(40);pump();expect(ended).toBe(1);expect(f.started()).toBe(0);expect(f.motion.phase).toBe('idle');
});
test('DYBACK right swipe leaves left-direction observers untouched',()=>{
 let negativeMoves=0;attachGesture({region,onMove:c=>{if(c.dx<0)negativeMoves++;}});const f=back();
 pump(30);pump(80);pump(180);pump();expect(f.motion.tick(2000)).toBe('commit');expect(negativeMoves).toBe(0);
});
for(const kind of ['vertical','progress','longpress'] as const)test(`DYBACK ${kind} owner cancels back`,()=>{
 const f=back();let fired=0;
 attachGesture(kind==='longpress'?{region,longPressSeconds:.01,onLongPress(){fired++;}}:{region,axis:kind==='vertical'?'y':'x',onPanStart(){fired++;}});
 pump(50);if(kind==='vertical')pump(60,160);else if(kind==='progress')pump(100);else for(let i=0;i<10;i++)pump(50);
 pump();expect(fired).toBe(1);expect(f.motion.tick(2000)).not.toBe('commit');
});
test('DYBACK tap does not start navigation',()=>{
 const f=back();let taps=0;attachGesture({region,onTap(){taps++;}});pump(100);pump();expect(taps).toBe(1);expect(f.started()).toBe(0);
});
