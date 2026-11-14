import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'player-detail-review-test',setup(b){b.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>({kind,props})])));
const gestures:any[]=[];mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);return {dispose(){}};}}));
const frames:{fn:()=>void;needs?:()=>boolean}[]=[];mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:()=>void,needs?:()=>boolean){const item={fn,needs};frames.push(item);onCleanup(()=>frames.splice(frames.indexOf(item),1));}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:()=>20})}));
const hits:unknown[][]=[],pressed:unknown[]=[];let hitTarget:any;
mock.module('@pocketjs/framework/input',()=>({hitNode(...args:unknown[]){hits.push(args);return hitTarget;},pressNode(node:unknown){pressed.push(node);}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>props}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{allowed:false}}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(set:any)=>{set('available');return()=>{};}}));
mock.module('../src/ui/route-activity.tsx',()=>({restoredSignal:(_kind:any,_key:any,value:any)=>createSignal(value),booleanState:(v:any)=>typeof v==='boolean'}));
let panelProps:any,arrowProps:any;
mock.module('../src/ui/PlayerDetailPanel.tsx',()=>({
 PlayerDetailArrow:(props:any)=>{arrowProps=props;return null;},
 PlayerDetailPanel:(props:any)=>{panelProps=props;props.ref?.({crown(){}});return null;},
 createDetailSlide:()=>{const [shown,set]=createSignal(false);return {shown,x:()=>shown()?0:233,begin(){},move(){set(true);},end(){},reset(){set(false);},open(){set(true);},close(){set(false);}};},
}));
let phase='active',listener:(phase:string)=>void=()=>{},prepared=0;
mock.module('@podjs/framework/watch',()=>({kv:{get(){},set(){}},hasCapability:()=>false,lifecycle:()=>phase,onLifecycleChange:(fn:any)=>{listener=fn;return()=>{};},normalizedRelativeAxisStep:(delta:number)=>Math.sign(delta)}));
let audioChanged:(v:any)=>void=()=>{};let actual=.5;const writes:number[]=[],polls:(()=>void)[]=[];
let sourceGeneration=1,sourcePosition=0,speed=1,speedGate:Promise<void>|undefined,volumeGate:Promise<void>|undefined,seekGate:Promise<void>|undefined;const speeds:number[]=[];
let videoWidth=540,videoHeight=960;
const value=()=>({speed,ok:true,state:'playing',positionMs:sourcePosition,durationMs:10000,width:videoWidth,height:videoHeight,volume:actual,volumeMax:16,hasRenderedFirstFrame:true,sourceGeneration,presented:true});
const port:any={prepare:()=>{prepared++;speed=1;sourcePosition=prepared*1000;return {result:Promise.resolve(value()),cancel(){}};},state:async()=>value(),setVolume:async(v:number)=>{writes.push(v);actual=Math.round(v*16)/16;const reply=value(),wait=volumeGate;volumeGate=undefined;await wait;return reply;}};
for(const method of ['play','pause','retire','seek','stop','setBounds','setTransform','setLoop'])port[method]=async()=>value();
mock.module('@podjs/framework/services',()=>({videoSessions:port,video:port,hostOperation:()=>({result:Promise.resolve({decoderLimit:1,maxSessions:1,surfacePromotion:false,verticalTransition:false}),cancel(){}}),onVideoAudioChanged:(fn:any)=>{audioChanged=fn;return()=>{};},onVideoFirstFrame:()=>()=>{},onVideoStateChanged:()=>()=>{},delay:(ms:number)=>({result:new Promise<void>(yes=>{if(ms===400)polls.push(yes);}),cancel(){}})}));
port.setSpeed=async(v:number)=>{speeds.push(v);const reply={...value(),speed:v};const wait=speedGate;speedGate=undefined;await wait;speed=v;return reply;};
port.seek=async(positionMs:number)=>{const reply={...value(),positionMs},wait=seekGate;seekGate=undefined;await wait;return reply;};
const {rotateVector}=await import('../src/ui/player-gestures.ts');
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
let dispose:undefined|(()=>void);afterEach(()=>{dispose?.();dispose=undefined;prepared=0;videoWidth=540;videoHeight=960;actual=.5;writes.length=0;speeds.length=0;polls.length=0;speedGate=undefined;volumeGate=undefined;seekGate=undefined;gestures.length=0;hits.length=0;pressed.length=0;hitTarget=undefined;});

const realNow=Date.now;let now=1000;Date.now=()=>now;
const transforms:any[]=[];port.setTransform=async(v:any)=>{transforms.push(v);return value();};
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);return v?.props?[v,...nodes(v.props.children)]:[];}
function mount(platform:'rss'|'douyin'|'bili',angle:number){
 let handle:any,replaceSource!:()=>void;const selected:string[]=[],panValues:number[]=[];
 const tree=createRoot(stop=>{dispose=stop;const [source,setSource]=createSignal({url:'local.mp4',title:'local',platform,immersive:platform==='douyin'});replaceSource=()=>setSource({...source(),url:'replacement.mp4'});return VideoPlayerScreen({get source(){return source();},width:233,height:233,offset:0,round:true,active:true,ref:v=>handle=v,onNext(){},onPrevious(){},onSelectTarget:d=>selected.push(d),onPanStateChange:v=>panValues.push(v)});});
 const press=(icon:string)=>{const button=nodes(tree).find(v=>v.props.onPress&&nodes(v.props.children).some(c=>c.props.src?.endsWith(`player-${icon}.svg`)));expect(button).toBeDefined();button.props.onPress();};
 return {handle,selected,panValues,tree,replaceSource,rotateStep(){press('rotate');},tick(ms:number){now+=ms;frames.slice().forEach(f=>f.fn());},rotate(){for(let i=0;i<angle/90;i++){press('rotate');now+=350;frames.slice().forEach(f=>f.fn());}},expand(){press('fullscreen');}};
}
for(const platform of ['rss','douyin','bili'] as const)for(const angle of [0,90,180,270])test(`${platform} component uses render angle ${angle}`,async()=>{
 const f=mount(platform,angle);await flush();f.rotate();await flush();expect(f.handle.gestureRotation()).toBe(angle);
 const g=gestures.find(g=>g.onTap&&g.onPanEnd);expect(g.axis).toBe(angle%180===0?'y':'x');
 if(platform==='douyin'){
  const v=rotateVector(0,-110,angle),velocity=rotateVector(0,-650,angle),c={id:1,dx:v.x,dy:v.y,vx:velocity.x,vy:velocity.y,x:100,y:100,startX:100-v.x,startY:100-v.y,fdx:v.x,fdy:v.y};
  g.onDown(c);g.onPanStart(c);g.onPanMove(c);g.onPanEnd(c);await flush();expect(f.selected).toEqual(['next']);
 }else{
  f.expand();await flush();const v=rotateVector(0,-20,angle),c={id:1,dx:v.x,dy:v.y,vx:0,vy:0,x:100,y:100,startX:100-v.x,startY:100-v.y,fdx:v.x,fdy:v.y};g.onDown(c);g.onPanStart(c);g.onPanMove(c);await flush();expect(f.panValues.at(-1)).toBe(-20);
  const t=transforms.at(-1),expected=rotateVector(0,-20,angle);expect(t.rotationDeg).toBe(angle);expect(t.panX??0).toBe(expected.x);expect(t.panY??0).toBe(expected.y);
  const velocity=rotateVector(0,-700,angle),release={...c,vx:velocity.x,vy:velocity.y};g.onUp?.(release);g.onPanEnd(release);f.tick(50);await flush();expect(f.panValues.at(-1)).toBeLessThan(-20);
 }
 f.handle.sideSwipe.begin();f.handle.sideSwipe.move(-100);nodes(f.tree);expect(f.handle.canSwipeBack()).toBe(false);
 expect(g.region.rect()).toBeNull();expect(gestures.find(g=>g.panSlop===8&&!g.onTap&&g.onPanEnd).region.rect()).toBeNull();
});

for(const platform of ['rss','bili'] as const)for(const angle of [0,90,180,270])test(`${platform} landscape pan velocity and picture-right boundary ${angle}`,async()=>{
 videoWidth=960;videoHeight=540;const f=mount(platform,angle);await flush();f.rotate();await flush();f.expand();await flush();expect(f.handle.canSwipeBack()).toBe(false);
 const g=gestures.find(g=>g.panSlop===8&&!g.onTap&&g.onPanEnd);expect(g.axis).toBe(angle%180===0?'x':'y');
 const contact=(distance:number,velocity:number)=>{const d=rotateVector(distance,0,angle),v=rotateVector(velocity,0,angle);return{id:1,dx:d.x,dy:d.y,vx:v.x,vy:v.y,x:100,y:100,startX:100-d.x,startY:100-d.y,fdx:d.x,fdy:d.y};};
 const c=contact(20,700);g.onDown(c);g.onPanStart(c);g.onPanMove(c);g.onPanEnd(c);await flush();expect(f.panValues.at(-1)).toBe(20);
 now+=50;frames.slice().forEach(f=>f.fn());await flush();expect(f.panValues.at(-1)).toBeGreaterThan(20);
 const edge=contact(10000,0);g.onDown(edge);g.onPanStart(edge);g.onPanMove(edge);await flush();expect(f.handle.canSwipeBack()).toBe(true);
});

for(const angle of [0,90,180,270])for(const fast of [false,true])test(`review: Douyin short swipe release speed ${angle}, fast=${fast}`,async()=>{
 const f=mount('douyin',angle);await flush();f.rotate();await flush();
 const g=gestures.find(g=>g.onTap&&g.onPanEnd),r=angle*Math.PI/180;
 const c={id:1,x:100,y:100,startX:100,startY:100,dx:20*Math.sin(r),dy:-20*Math.cos(r),fdx:0,fdy:0,vx:(fast?650:20)*Math.sin(r),vy:-(fast?650:20)*Math.cos(r)};
 g.onDown(c);g.onPanStart(c);g.onPanMove(c);g.onPanEnd(c);await flush();expect(f.selected).toEqual(fast?['next']:[]);
});
for(const platform of ['rss','bili','douyin'] as const)for(const angle of [0,90,180,270])test(`review: ${platform} real player hitNode receives screen coordinates ${angle}`,async()=>{
 const f=mount(platform,angle);await flush();f.rotate();await flush();
 hitTarget={onPress(){}};const c={id:1,surface:'primary',x:17,y:89,startX:17,startY:89,dx:0,dy:0,fdx:0,fdy:0,vx:0,vy:0};
 const g=gestures.find(g=>g.onTap&&g.onPanEnd);g.onDown(c);g.onUp?.(c);g.onTap(c);
 expect(hits.at(-1)).toEqual([17,89,'primary']);expect(pressed.at(-1)).toBe(hitTarget);
});
test('review: actual display angle at down survives the rest of the rotation tween',async()=>{
 const f=mount('douyin',0);await flush();f.rotateStep();f.tick(60);await flush();
 const angle=f.handle.gestureRotation();expect(angle).toBeCloseTo(43.92);
 const r=angle*Math.PI/180,c={id:1,x:100,y:100,startX:100,startY:100,dx:110*Math.sin(r),dy:-110*Math.cos(r),fdx:0,fdy:0,vx:650*Math.sin(r),vy:-650*Math.cos(r)};
 const g=gestures.find(g=>g.onTap&&g.onPanEnd);g.onDown(c);f.tick(300);await flush();expect(f.handle.gestureRotation()).toBe(90);
 g.onPanStart(c);g.onPanMove(c);g.onUp?.(c);g.onPanEnd(c);await flush();expect(f.selected).toEqual(['next']);
});
for(const angle of [90,180,270])test(`review: real source replacement after down retains angle ${angle}`,async()=>{
 const f=mount('douyin',angle);await flush();f.rotate();await flush();const r=angle*Math.PI/180;
 const c={id:1,x:100,y:100,startX:100,startY:100,dx:110*Math.sin(r),dy:-110*Math.cos(r),fdx:0,fdy:0,vx:650*Math.sin(r),vy:-650*Math.cos(r)};
 const g=gestures.find(g=>g.onTap&&g.onPanEnd);g.onDown(c);f.replaceSource();await flush();expect(f.handle.gestureRotation()).toBe(0);
 g.onPanStart(c);g.onPanMove(c);g.onUp?.(c);g.onPanEnd(c);await flush();expect(f.selected).toEqual(['next']);
});
