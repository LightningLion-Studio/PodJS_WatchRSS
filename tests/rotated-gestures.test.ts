import {afterEach,expect,test} from 'bun:test';
import {attachGesture,__runGestures,resetGestures,type GestureContact} from '@pocketjs/framework/gesture';
import {__packTouch,__resetTouches,__setTouches} from '../node_modules/@pocketjs/framework/framework/src/touch.ts';
import {__advanceClock,resetClock} from '../node_modules/@pocketjs/framework/framework/src/clock.ts';
import {rightSwipeBack} from '../src/navigation/right-swipe-back.ts';
import {BackMotion} from '@podjs/framework/navigation';
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

// Independent trigonometry and the real recognizer expose quarter-axis rounding
// errors that a test invoking onPanStart directly cannot observe.
for(const angle of [30,60,120,150,210,240,300,330])for(const [dx,dy,expected] of [
 [80,60,'back'],[-80,-60,'panel'],[60,-80,'next'],[-60,80,'previous'],
] as const)test(`review: tween ${angle} classifies picture vector ${dx}/${dy}`,()=>{
 const events:string[]=[];
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:c=>events.push(c.dx<0?'panel':'back')},()=>angle,viewport));
 attachGesture(playerGesture({region,axis:'y',panSlop:8,onPanStart:c=>events.push(c.dy<0?'next':'previous')},()=>angle,viewport));
 const r=angle*Math.PI/180,x=dx*Math.cos(r)-dy*Math.sin(r),y=dx*Math.sin(r)+dy*Math.cos(r);
 pump(116-x/2,116-y/2);pump(116,116);pump(116+x/2,116+y/2);pump();
 expect(events).toEqual([expected]);
});
test('review: a second contact cannot overwrite the first contact down angle',()=>{
 let angle=90;const moves:number[]=[];
 const options=playerGesture({axis:'y',panSlop:8,onPanMove:c=>moves.push(c.dy)},()=>angle,viewport);
 const c={id:1,surface:'primary',x:100,y:100,startX:20,startY:100,dx:80,dy:0,fdx:80,fdy:0,vx:700,vy:0} as GestureContact;
 options.onDown?.({...c,dx:0,fdx:0});angle=0;options.onDown?.({...c,id:2,dx:0,fdx:0});options.onPanMove?.(c);
 expect(moves).toEqual([-80]);
});
test('review: onUp precedes onPanEnd without losing the locked release velocity',()=>{
 let angle=270;const values:number[]=[];
 const options=playerGesture({axis:'y',panSlop:8,onUp:c=>values.push(c.vy),onPanStart(){},onPanEnd:c=>values.push(c.vy)},()=>angle,viewport);
 const c={id:1,surface:'primary',x:100,y:100,startX:180,startY:100,dx:-80,dy:0,fdx:-80,fdy:0,vx:-700,vy:0} as GestureContact;
 options.onDown?.(c);options.onPanStart?.(c);angle=0;options.onUp?.(c);options.onPanEnd?.(c);
 expect(values).toEqual([-700,-700]);expect(options.axis).toBe('y');
});
for(const angle of [0,30,90,180,270])test(`review: taps and long presses keep screen contact identity ${angle}`,()=>{
 let tap:GestureContact|undefined,hold:GestureContact|undefined;
 const options=playerGesture({onTap:c=>tap=c,onLongPress:c=>hold=c},()=>angle,viewport);
 const c={id:1,surface:'primary',x:17,y:89,startX:17,startY:89,dx:0,dy:0,fdx:0,fdy:0,vx:0,vy:0} as GestureContact;
 options.onDown?.(c);options.onUp?.(c);options.onTap?.(c);options.onLongPress?.(c);
 expect(tap).toBe(c);expect(hold).toBe(c);
});

for(const angle of [45,135,225,315])test(`review: picture-axis ties retain vertical recognizer priority ${angle}`,()=>{
 const events:string[]=[];
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:()=>events.push('x')},()=>angle,viewport));
 attachGesture(playerGesture({region,axis:'y',panSlop:8,onPanStart:()=>events.push('y')},()=>angle,viewport));
 // Exact screen axes avoid truncating a floating-point zero to a stray 1px.
 const [x,y]=({45:[0,98],135:[-98,0],225:[0,-98],315:[98,0]} as Record<number,number[]>)[angle];
 pump(116-x/2,116-y/2);pump(116+x/2,116+y/2);pump();expect(events).toEqual(['y']);
});
test('review: oblique ownership and first-frame delta consume eight picture pixels',()=>{
 const starts:GestureContact[]=[];
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:c=>starts.push({...c})},()=>30,viewport));
 pump(100,100);pump(106,103);expect(starts).toHaveLength(0);pump(109,105);pump();
 expect(starts).toHaveLength(1);expect(starts[0].fdx).toBeCloseTo(starts[0].dx-8);
});
for(const angle of [0,30,90,180,270])for(const fast of [false,true])test(`review: BackMotion release threshold ${angle}, fast=${fast}`,()=>{
 const motion=new BackMotion(233);
 attachGesture(playerGesture({region,axis:'x',panSlop:8,onPanStart:c=>motion.begin(c.dx),onPanMove:c=>motion.move(c.dx),onPanEnd:c=>motion.release(c.vx,1000)},()=>angle,viewport));
 const r=angle*Math.PI/180;const point=(distance:number)=>pump(100+distance*Math.cos(r),100+distance*Math.sin(r));
 point(0);const steps=fast?2:16;for(let i=1;i<=steps;i++)point(40*i/steps);pump();
 expect(motion.tick(2000)).toBe(fast?'commit':'cancel');
});
test('review: 0-degree real-recognizer callback traces match the legacy adapter',()=>{
 const paths=[[[100,100],[108,108],[109,109],[130,140]],[[100,100],[80,101],[40,102]],[[20,20],[35,20],[24,20]],
  Array.from({length:40},()=>[100,100]),[[100,100],[101,101]],[[100,100],[100,160],[100,160],[100,160]]];
 const run=(adapt:boolean,path:number[][])=>{
  resetGestures();__resetTouches();resetClock();const events:unknown[]=[];
  for(const axis of ['x','y'] as const){
   const record=(name:string)=>(c:GestureContact)=>events.push([axis,name,...['id','x','y','startX','startY','dx','dy','fdx','fdy','vx','vy','downFrame','frames'].map(k=>c[k as keyof GestureContact])]);
   const options={region,axis,panSlop:8,onDown:record('down'),onMove:record('move'),onUp:record('up'),onCancel:record('cancel'),onPanStart:record('start'),onPanMove:record('pan'),onPanEnd:record('end'),onTap:record('tap'),onLongPress:record('hold')};
   attachGesture(adapt?playerGesture(options,()=>0,viewport):options);
  }
  for(const [x,y] of path)pump(x,y);pump();resetGestures();return events;
 };
 for(const path of paths)expect(run(true,path)).toEqual(run(false,path));
});
test('review: real disposal cancels a live contact and drops its locked angle',()=>{
 let angle=90;const cancelled:GestureContact[]=[];
 const options=playerGesture({region,axis:'y',panSlop:8,onPanStart(){},onCancel:c=>cancelled.push({...c})},()=>angle,viewport);
 const handle=attachGesture(options);pump(80,100);pump(120,100);angle=0;handle.dispose();
 expect(cancelled).toHaveLength(1);expect(cancelled[0].id).toBe(1);expect(cancelled[0].dy).toBe(-40);expect(options.axis).toBe('y');
});
