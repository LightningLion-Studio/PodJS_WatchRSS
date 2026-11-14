import {afterEach,expect,test} from 'bun:test';
import {attachGesture,__runGestures,resetGestures,type GestureContact} from '@pocketjs/framework/gesture';
import {__packTouch,__resetTouches,__setTouches} from '../node_modules/@pocketjs/framework/framework/src/touch.ts';
import {__advanceClock,resetClock} from '../node_modules/@pocketjs/framework/framework/src/clock.ts';
import {rightSwipeBack} from '../src/navigation/right-swipe-back.ts';
import {playerCoordinates,playerGesture,rotateVector} from '../src/ui/player-gestures.ts';
const viewport=()=>({x:0,y:0,w:233,h:233}),region={rect:viewport};
const directions={up:[0,-100],down:[0,100],right:[100,0],left:[-100,0]} as const;
function pump(x?:number,y=116){__advanceClock();__setTouches(x===undefined?[]:[__packTouch(1,x,y)]);__runGestures();}
afterEach(()=>{resetGestures();__resetTouches();resetClock();});
for(const angle of [0,90,180,270])for(const [direction,[dx,dy]] of Object.entries(directions))for(const action of ['switch','back','panel'])test(`${angle} ${direction} ${action}`,()=>{
 const events:string[]=[];
 attachGesture(playerGesture(rightSwipeBack(region,{start(){events.push('back');},move(){},end(){},cancel(){}}),()=>angle,viewport));
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:c=>{if(c.dx<0)events.push('panel');}},()=>angle,viewport));
 attachGesture(playerGesture({region,axis:'y',panSlop:8,onPanStart:c=>events.push(c.dy<0?'next':'previous')},()=>angle,viewport));
 const d=rotateVector(dx,dy,angle);pump(116-d.x/2,116-d.y/2);pump(116,116);pump(116+d.x/2,116+d.y/2);pump();
 const expected=direction==='right'?'back':direction==='left'?'panel':direction==='up'?'next':'previous';
 expect(events.includes(action==='switch'?'next':action)).toBe(action==='switch'?direction==='up':expected===action);
 expect(events).toEqual([expected]);
});
test('0 degrees preserves every contact field and the legacy classification',()=>{
 for(let dx=-40;dx<=40;dx+=4)for(let dy=-40;dy<=40;dy+=4){
  const c={x:50+dx,y:60+dy,startX:50,startY:60,dx,dy,fdx:dx/2,fdy:dy/2,vx:dx*10,vy:dy*10,id:1,surface:'primary',downFrame:0,frames:1} as GestureContact;
  const actual=playerCoordinates(c,0,viewport());expect(actual).toBe(c);
  const classify=(c:GestureContact)=>Math.abs(c.dx)>=Math.abs(c.dy)?(c.dx>8?'back':c.dx< -8?'panel':'none'):(c.dy< -8?'next':c.dy>8?'previous':'none');
  expect(classify(actual)).toBe(classify(c));
 }
});
for(const angle of [0,90,180,270])test(`points, edge start, frame delta and release velocity ${angle}`,()=>{
 const p=rotateVector(-110,20,angle),d=rotateVector(90,-40,angle),v=rotateVector(600,-900,angle);
 const c={x:116.5+p.x+d.x,y:116.5+p.y+d.y,startX:116.5+p.x,startY:116.5+p.y,dx:d.x,dy:d.y,fdx:d.x/3,fdy:d.y/3,vx:v.x,vy:v.y,id:1} as GestureContact;
 const actual=playerCoordinates(c,angle,viewport());expect(actual.startX).toBeCloseTo(6.5);expect(actual.startY).toBeCloseTo(136.5);expect(actual.dx).toBeCloseTo(90);expect(actual.dy).toBeCloseTo(-40);expect(actual.fdx).toBeCloseTo(30);expect(actual.fdy).toBeCloseTo(-40/3);expect(actual.vx).toBeCloseTo(600);expect(actual.vy).toBeCloseTo(-900);
});
test('viewport offset and rectangular dimensions use the picture origin',()=>{
 const c={x:200,y:140,startX:200,startY:140,dx:0,dy:0,fdx:0,fdy:0,vx:0,vy:0} as GestureContact;
 const actual=playerCoordinates(c,90,{x:10,y:30,w:300,h:200});expect(actual.startX).toBe(110);expect(actual.startY).toBe(110);
});
test('release keeps the down rotation if a source replacement resets rendering',()=>{
 let angle=90,velocity=0;
 const options=playerGesture({axis:'x',onPanEnd:c=>velocity=c.vx},()=>angle,viewport);
 const c={id:1,dx:0,dy:100,vx:0,vy:700,fdx:0,fdy:0,x:100,y:100,startX:100,startY:0} as GestureContact;
 options.onDown?.(c);angle=0;options.onPanEnd?.(c);expect(velocity).toBe(700);
});
for(const angle of [0,90,180,270])for(const [direction,[dx,dy]] of Object.entries(directions))test(`shell signed dispatcher ${angle} ${direction}`,()=>{
 const events:string[]=[];
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:c=>events.push(c.dx<0?'panel':'back')},()=>angle,viewport));
 attachGesture(playerGesture({region,axis:'y',panSlop:8,onPanStart:c=>events.push(c.dy<0?'next':'previous')},()=>angle,viewport));
 const v=rotateVector(dx,dy,angle);pump(116-v.x/2,116-v.y/2);pump(116,116);pump(116+v.x/2,116+v.y/2);pump();
 expect(events).toEqual([direction==='right'?'back':direction==='left'?'panel':direction==='up'?'next':'previous']);
});
