import {FocusScope,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo,createSignal,onCleanup} from 'solid-js';
import {createGesture,pushTouchBlock} from '@pocketjs/framework/gesture';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {BackMotion} from '@podjs/framework/navigation';
import {hitFocusable,pressNode} from '@pocketjs/framework/input';
import {onSystemBack} from '@podjs/framework/watch';
import {playerGesture,rotateVector} from './player-gestures.ts';
import {rightSwipeBack,rightSwipeSlop} from '../navigation/right-swipe-back.ts';
import type {InternetStatus} from '../onboarding/state.ts';
import {networkMessages,NetworkAvailabilityStatusBar,OnboardingPrimaryButton} from './OnboardingNetworkScreen.tsx';
import {watchUiLines} from './text-layout.ts';

/** Same type, copy, colors, indicator and action as onboarding/Compose.
 * Geometry uses a 233-unit canvas. Every visible rectangle fits the safe circle. */
type OverlayProps={width:number;height:number;round?:boolean;rotation?:number;status:InternetStatus;actionText?:string;onAction:()=>void;translation?:{x:number;y:number}};
export function NetworkUnavailableOverlay(props:OverlayProps){
 const size=()=>Math.min(props.width,props.height),scale=()=>size()/233;
 const guidance=createMemo(()=>watchUiLines(networkMessages[props.status].guidance,{width:180,measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(networkMessages[props.status].status,{width:190,measure:t=>getOps().measureText(t,19)}));
 const barTop=()=>57+guidance().length*14+(props.status==='bluetooth'?12:18);
 return <View class={props.translation?"absolute inset-0 bg-[#000000]":"absolute inset-0 bg-[#000000f0]"}
  style={props.translation?{translateX:props.translation.x,translateY:props.translation.y}:undefined} onPress={()=>{}} accessibilityLabel="互联网"><View class="absolute" style={{insetL:(props.width-233)/2,insetT:(props.height-233)/2,width:233,height:233,scale:scale(),rotate:props.rotation??0}}>
   <Text class="absolute left-[71.5] top-[18] w-[90] h-[29] text-2xl leading-[29] text-[#f5f5f5] text-center">互联网</Text>
   <Text class="absolute text-xs leading-[14] text-[#f5f5f5] text-center" style={{insetL:26.5,insetT:57,width:180,height:guidance().length*14}}>{guidance().join('\n')}</Text>
   <View class="absolute h-[42]" style={{insetL:12.5,insetT:barTop(),width:208}}><NetworkAvailabilityStatusBar status={props.status}/></View>
   <Text class="absolute text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetL:21.5,insetT:barTop()+50,width:190,height:status().length*11}}>{status().join('\n')}</Text>
   <View class="absolute top-[174] left-[60.5] w-[112] h-[42] items-center justify-center"><OnboardingPrimaryButton text={props.actionText??"重试"} enabled={props.status!=='checking'} onPress={props.onAction}/></View>
  </View></View>;
}
const swipeFrameMs=1000/60;

export function NetworkBluetoothPage(props:{width:number;height:number;rotation?:number;onDismiss:()=>void}){
 const viewport=()=>({x:0,y:0,w:props.width,h:props.height});
 const rotation=()=>props.rotation??0;
 const [translation,setTranslation]=createSignal({x:0,y:0});
 let swipeRotation=0,settleFrames=0;
 let motion=new BackMotion(props.width);
 const updateTranslation=()=>setTranslation(rotateVector(motion.offset,0,swipeRotation));
 const release=(velocity:number,cancelled=false)=>{
  settleFrames=0;
  motion.release(velocity,0,cancelled);
 };
 const dismiss=()=>{if(motion.phase==='idle')props.onDismiss();};

 // Block the lower route even in the part of the viewport revealed by the drag.
 onCleanup(pushTouchBlock());
 onCleanup(onSystemBack(()=>true));
 const swipe=rightSwipeBack({rect:()=>motion.phase==='idle'?viewport():null},{
  start(dx){
   const axis=rotateVector(1,0,swipeRotation);
   motion=new BackMotion(Math.min(props.width/Math.abs(axis.x),props.height/Math.abs(axis.y)));
   motion.begin(dx);
  },
  move(dx){motion.move(dx);updateTranslation();},
  end:release,
  cancel:()=>release(0,true),
 });
 createGesture(playerGesture({
  ...swipe,
  allowWhenBlocked:true,
  tapSlop:rightSwipeSlop,
  onDown(c){swipeRotation=rotation();swipe.onDown?.(c);},
  // The framework's default touch activation shares the lower route's block.
  // Resolve the button through this page's focus scope.
  onTap(c){
   if(motion.phase!=='idle')return;
   const target=hitFocusable(c.x,c.y);
   if(target)pressNode(target);
  },
 },rotation,viewport));
 onFrame(()=>{
  if(motion.phase!=='settling')return;
  const result=motion.tick(++settleFrames*swipeFrameMs);
  updateTranslation();
  if(result==='commit')dismiss();
 },()=>motion.phase==='settling');

 return <FocusScope class="absolute inset-0 z-40 overflow-hidden">
  <NetworkUnavailableOverlay width={props.width} height={props.height} rotation={rotation()} status="bluetooth"
   translation={translation()} actionText="继续" onAction={dismiss}/>
 </FocusScope>;
}
