import {createSignal,onCleanup,Show} from "solid-js";
import {View,Text,type NodeMirror} from "@pocketjs/framework/components";
import {createGesture} from "@pocketjs/framework/gesture";
import {onFrame} from "@pocketjs/framework/lifecycle";
import {delay} from "@podjs/framework/services";
import {TiledImage} from "./TiledImage.tsx";
import {WatchProgressIndicator} from "./WatchProgressIndicator.tsx";
import {DownloadPhoneAppDialog} from "./DownloadPhoneAppDialog.tsx";
import {clampPreview,nextPreviewScale,previewCanStartBack,previewMaxScale,pinchPreviewStep,previewScaleDecayStep,previewPanDecayStep,zoomPreview,type PreviewState} from "./image-preview.ts";
export function ImagePreviewScreen(props:{url:string;filePath?:string;width:number;height:number;density:number;active:boolean;onExit:()=>void;onError?:(message:string)=>void;onBackGesture:(phase:"start"|"move"|"end"|"cancel",dx:number,velocity:number)=>void}){
 const [size,setSize]=createSignal({width:props.width,height:props.height}),[state,setState]=createSignal<PreviewState>({scale:1,x:0,y:0}),[loaded,setLoaded]=createSignal(false),[failed,setFailed]=createSignal(false),[showDownload,setShowDownload]=createSignal(false);
 const localImage=()=>!!props.filePath||props.url.startsWith("/")||props.url.startsWith("file://")||props.url.startsWith("assets/");
 let node:NodeMirror|undefined,tapTimer:ReturnType<typeof delay>|undefined,lastFrame=0,vx=0,vy=0;
 let backDragging=false;
 let target:PreviewState|undefined,scaleVelocity=0,offsetVX=0,offsetVY=0;
 let pinchSpan=1,pinchX=0,pinchY=0,pinchTime=0,lastScaleAt=0,lastScaleDelta=0,pinchVelocity=0,scaleFlingVelocity=0;
 let pinchPanVX=0,pinchPanVY=0,pinchPanDistance=0,lastPanX=0,lastPanY=0;
 let pinchHistory:{x:number;y:number;time:number}[]=[];
 const geometry=()=>({width:props.width,height:props.height,imageWidth:size().width,imageHeight:size().height,density:props.density});
 const cancel=()=>{tapTimer?.cancel();tapTimer=undefined;target=undefined;vx=vy=0;scaleVelocity=offsetVX=offsetVY=scaleFlingVelocity=0;};
 const animate=(next:PreviewState)=>{target=next;scaleVelocity=offsetVX=offsetVY=0;};
 const updatePinch=(p:{span:number;cx:number;cy:number})=>{
  const now=Date.now(),current=state(),nextScale=Math.max(.5,Math.min(previewMaxScale(geometry()),current.scale*p.span/Math.max(1,pinchSpan)));
  const delta=nextScale-current.scale,scaling=Math.abs(delta)>.000018;
  if(scaling)lastScaleAt=now;
  const ignorePan=!scaling&&lastScaleAt!==0&&now-lastScaleAt<100;
  const panX=ignorePan?0:p.cx-pinchX,panY=ignorePan?0:p.cy-pinchY;
  setState(pinchPreviewStep(geometry(),current,p.span/Math.max(1,pinchSpan),p.cx,p.cy,panX,panY));
  if(scaling){pinchVelocity=pinchVelocity*.2+delta*1000/Math.max(1,now-pinchTime)*.8;lastScaleDelta=delta;}
  if(!ignorePan&&(panX!==0||panY!==0)){
   pinchPanDistance+=Math.hypot(panX,panY);lastPanX=panX;lastPanY=panY;
   const dt=Math.max(1,now-pinchTime);pinchPanVX=pinchPanVX*.2+panX*1000/dt*.8;pinchPanVY=pinchPanVY*.2+panY*1000/dt*.8;
  }
  if(!ignorePan){pinchHistory.push({x:p.cx,y:p.cy,time:now});if(pinchHistory.length>4)pinchHistory.shift();}
  pinchSpan=p.span;pinchX=p.cx;pinchY=p.cy;pinchTime=now;
 };
 createGesture({region:{node:()=>props.active?node:null},axis:"any",
  onDown:()=>{target=undefined;vx=vy=scaleFlingVelocity=0;},
  onTap:c=>{if(!loaded())return;if(tapTimer){tapTimer.cancel();tapTimer=undefined;animate(zoomPreview(geometry(),state(),nextPreviewScale(geometry(),state().scale),c.x,c.y));}else{tapTimer=delay(300);void tapTimer.result.then(()=>{tapTimer=undefined;if(props.active){props.onExit();}},()=>{});}},
  onPanStart:c=>{cancel();backDragging=previewCanStartBack(geometry(),state(),c.startX,c.dx,c.dy);if(backDragging)props.onBackGesture("start",c.dx,c.vx);},
  onPanMove:c=>{if(backDragging)props.onBackGesture("move",c.dx,c.vx);else setState(clampPreview(geometry(),{...state(),x:state().x+c.fdx,y:state().y+c.fdy}));},
  onPanEnd:c=>{if(backDragging){props.onBackGesture("end",c.dx,c.vx);backDragging=false;}else{vx=c.vx;vy=c.vy;}},
  onPinchStart:p=>{cancel();pinchSpan=p.startSpan;pinchX=p.cx;pinchY=p.cy;pinchTime=Date.now();lastScaleAt=0;lastScaleDelta=pinchVelocity=pinchPanVX=pinchPanVY=pinchPanDistance=lastPanX=lastPanY=0;pinchHistory=[{x:p.cx,y:p.cy,time:pinchTime}];},
  onPinchMove:updatePinch,
  onPinchEnd:p=>{
   if(p.span!==pinchSpan||p.cx!==pinchX||p.cy!==pinchY)updatePinch(p);
   scaleFlingVelocity=Math.abs(pinchVelocity)>.0009?pinchVelocity:Math.abs(lastScaleDelta)>.000018?lastScaleDelta*120:0;
   if(pinchPanDistance>1){
    const first=pinchHistory[0],last=pinchHistory.at(-1),dt=first&&last?Math.max(1,last.time-first.time):1;
    const trackerX=first&&last?(last.x-first.x)*1000/dt:0,trackerY=first&&last?(last.y-first.y)*1000/dt:0;
    if(Math.hypot(trackerX,trackerY)>5){vx=trackerX;vy=trackerY;}
    else if(Math.hypot(pinchPanVX,pinchPanVY)>5){vx=pinchPanVX;vy=pinchPanVY;}
    else if(Math.hypot(lastPanX,lastPanY)>.5){vx=lastPanX*80;vy=lastPanY*80;}
   }
  },
  onCancel:()=>{if(backDragging){props.onBackGesture("cancel",0,0);backDragging=false;}cancel();}
 });
 onFrame(()=>{
  const now=Date.now(),dt=lastFrame?Math.min(.05,(now-lastFrame)/1000):0;lastFrame=now;if(!props.active||!dt)return;
  const current=state();
  if(target){
   // Native low-stiffness, medium-bouncy spring (200, damping ratio .5).
   const k=200,damping=2*.5*Math.sqrt(k),steps=Math.max(1,Math.ceil(dt/.008)),step=dt/steps;let next={...current};
   for(let i=0;i<steps;i++){scaleVelocity+=(k*(target.scale-next.scale)-damping*scaleVelocity)*step;offsetVX+=(k*(target.x-next.x)-damping*offsetVX)*step;offsetVY+=(k*(target.y-next.y)-damping*offsetVY)*step;next={scale:next.scale+scaleVelocity*step,x:next.x+offsetVX*step,y:next.y+offsetVY*step};}
   setState(clampPreview(geometry(),next));if(Math.abs(next.scale-target.scale)<.001&&Math.abs(next.x-target.x)<.1&&Math.abs(next.y-target.y)<.1&&Math.abs(scaleVelocity)<.01&&Math.abs(offsetVX)+Math.abs(offsetVY)<1){setState(target);target=undefined;}
  }else{
   let next=current;
   if(Math.abs(scaleFlingVelocity)>.1){const decay=previewScaleDecayStep(geometry(),next,scaleFlingVelocity,dt);next=decay.state;scaleFlingVelocity=decay.velocity;}
   if(Math.abs(vx)+Math.abs(vy)>1){const moved=previewPanDecayStep(geometry(),next,vx,vy,dt);vx=moved.vx;vy=moved.vy;next=moved.state;}
   if(next!==current)setState(next);
  }
 });
 onCleanup(cancel);
 return <View ref={n=>node=n} class="absolute inset-0 bg-black overflow-hidden"><TiledImage url={props.url} filePath={props.filePath} geometry={geometry()} state={state()} onError={()=>setFailed(true)} onSize={(width,height)=>{if(size().width!==width||size().height!==height)setSize({width,height});setLoaded(true);}}/>
  <Show when={!loaded()&&!failed()}><View class="absolute" style={{insetL:(props.width-40)/2,insetT:(props.height-40)/2,width:40,height:40}}><WatchProgressIndicator active={()=>props.active&&!loaded()&&!failed()}/></View></Show>
  <Show when={!loaded()&&failed()}><View class="absolute" style={{insetL:0,insetT:props.height/2-(localImage()?24:17),width:props.width,height:localImage()?48:34}}>
   <View class="absolute justify-center" style={{insetL:0,insetT:0,width:props.width}}><Text class="text-sm leading-[17]" style={{textColor:"#b6b6b6"}}>{localImage()?"图片未同步":"图片加载失败"}</Text></View>
   <View class="absolute justify-center" style={{insetL:0,insetT:17,width:props.width}}><Text class="text-sm leading-[17]" style={{textColor:"#b6b6b6"}}>{localImage()?"请在手机端重新同步":"请稍后重试"}</Text></View>
   <Show when={localImage()}><View onPress={()=>setShowDownload(true)} focusable accessibilityRole="button" accessibilityLabel="下载手机端app以在手机上编辑和同步内容" class="absolute items-center justify-center active:scale-96" style={{insetL:0,insetT:34,width:props.width,height:14}}><Text class="text-xs leading-[14] text-center text-[#b6b6b6]">下载手机端app以在手机上编辑和同步内容</Text><View class="absolute bg-[#b6b6b6]" style={{insetL:4,insetR:4,insetT:12.5,height:.5}}/></View></Show>
  </View></Show>
  <Show when={showDownload()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="同步备忘录" onDismiss={()=>setShowDownload(false)} onError={message=>props.onError?.(message)}/></Show>
 </View>;
}
