import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo,createSignal} from 'solid-js';
import {createGesture,pushTouchBlock} from '@pocketjs/framework/gesture';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {BackMotion} from '@podjs/framework/navigation';
import {isRightSwipe,rightSwipeSlop} from '../navigation/right-swipe-back.ts';
import type {InternetStatus} from '../onboarding/state.ts';
import {networkMessages,NetworkAvailabilityStatusBar,OnboardingPrimaryButton} from './OnboardingNetworkScreen.tsx';
import {watchUiLines} from './text-layout.ts';

/** Same type, copy, colors, indicator and action as onboarding/Compose.
 * Geometry uses a 233-unit canvas. Every visible rectangle fits the safe circle.
 * The Bluetooth notice below is separate so playback and page input remain usable. */
type OverlayProps={width:number;height:number;round?:boolean;rotation?:number;status:InternetStatus;onRetry:()=>void};
export function NetworkUnavailableOverlay(props:OverlayProps){
 const size=()=>Math.min(props.width,props.height),scale=()=>size()/233;
 const guidance=createMemo(()=>watchUiLines(networkMessages[props.status].guidance,{width:180,measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(networkMessages[props.status].status,{width:190,measure:t=>getOps().measureText(t,19)}));
 const barTop=()=>57+guidance().length*14+(props.status==='bluetooth'?12:18);
 return <View class="absolute inset-0 bg-[#000000f0]" onPress={()=>{}} accessibilityLabel="互联网"><View class="absolute" style={{insetL:(props.width-233)/2,insetT:(props.height-233)/2,width:233,height:233,scale:scale(),rotate:props.rotation??0}}>
   <Text class="absolute left-[71.5] top-[18] w-[90] h-[29] text-2xl leading-[29] text-[#f5f5f5] text-center">互联网</Text>
   <Text class="absolute text-xs leading-[14] text-[#f5f5f5] text-center" style={{insetL:26.5,insetT:57,width:180,height:guidance().length*14}}>{guidance().join('\n')}</Text>
   <View class="absolute h-[42]" style={{insetL:12.5,insetT:barTop(),width:208}}><NetworkAvailabilityStatusBar status={props.status}/></View>
   <Text class="absolute text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetL:21.5,insetT:barTop()+50,width:190,height:status().length*11}}>{status().join('\n')}</Text>
   <View class="absolute top-[174] left-[60.5] w-[112] h-[42] items-center justify-center"><OnboardingPrimaryButton text="重试" enabled={props.status!=='checking'} onPress={props.onRetry}/></View>
  </View></View>;
}
const swipeFrameMs = 1000/60;

/** Only this compact card handles its own tap. The viewport gesture claims
 * rightward pans and leaves every other direction in the gesture arena.
 * A fully opaque black plate (8-unit padding, 196 wide) keeps the copy legible over lists;
 * its corners stay inside the 233-unit safe circle for 1-2 line guidance. */
export function NetworkBluetoothNotice(props:{width:number;height:number;onDismiss:()=>void}){
 const scale=()=>Math.min(props.width,props.height)/233;
 const [offset,setOffset]=createSignal(0);
 let motion=new BackMotion(props.width),activeContact:number|undefined;
 let rightwardContact:number|undefined,canPan=false,settleFrames=0;
 const settle=(velocity:number,cancelled=false)=>{
  activeContact=undefined;
  settleFrames=0;
  motion.release(velocity,0,cancelled);
 };
 const viewport={rect:()=>({x:0,y:0,w:props.width,h:props.height})};
 createGesture({
  region:viewport,
  axis:'x',
  allowWhenBlocked:true,
  get panSlop(){return canPan?rightSwipeSlop:Infinity;},
  onMove(c){canPan=rightwardContact===c.id;},
  onPanStart(c){
   canPan=false;
   if(motion.phase!=='idle')return;
   activeContact=c.id;
   motion=new BackMotion(props.width);
   motion.begin(c.dx);
  },
  onPanMove(c){
   if(c.id!==activeContact)return;
   motion.move(c.dx);
   setOffset(motion.offset);
  },
  onUp(c){if(c.id===rightwardContact)rightwardContact=undefined;},
  onPanEnd(c){if(c.id===activeContact)settle(c.vx);},
  onCancel(c){
   if(c.id===rightwardContact)rightwardContact=undefined;
   if(c.id===activeContact)settle(0,true);
  },
 });
 // The arena runs onMove before choosing the pan owner. A list can mount
 // new recognizers after this notice, so cancel its candidates at the
 // rightward threshold. Release the block immediately for subsequent
 // contacts. Keeping this observer non-exempt preserves modal touch blocks.
 createGesture({region:viewport,onMove(c){
  if(!isRightSwipe(c.dx,c.dy))return;
  rightwardContact=c.id;
  pushTouchBlock()();
 }});
 onFrame(()=>{
  if(motion.phase!=='settling')return;
  const result=motion.tick(++settleFrames*swipeFrameMs);
  setOffset(motion.offset);
  if(result==='commit')props.onDismiss();
 },()=>motion.phase==='settling');
 const guidance=createMemo(()=>watchUiLines(networkMessages.bluetooth.guidance,{width:180,measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(networkMessages.bluetooth.status,{width:180,measure:t=>getOps().measureText(t,19)}));
 const height=()=>66+guidance().length*14+8+status().length*11;
 const left=()=>props.width/2-98*scale(),top=()=>props.height/2-height()*scale()/2;
 // Keep the page's node-based pan regions eligible under the card. A
 // separate tap recognizer covers only the visual card's current bounds.
 createGesture({
  region:{rect:()=>({x:left()+offset(),y:top(),w:196*scale(),h:height()*scale()})},
  onTap:()=>props.onDismiss(),
 });
 return <View class="absolute rounded-[24] bg-[#000000]" style={{insetL:left(),insetT:top(),width:196,height:height(),scale:scale(),originX:-.5,originY:-.5,translateX:offset(),opacity:1-offset()/props.width,hitPass:1}} onPress={props.onDismiss} accessibilityLabel={networkMessages.bluetooth.guidance}>
  <View class="absolute left-[8] right-[8] top-[8] h-[42]" style={{hitPass:1}}><NetworkAvailabilityStatusBar status="bluetooth" hitPass={1}/></View>
  <Text class="absolute left-[8] right-[8] top-[58] text-xs leading-[14] text-[#f5f5f5] text-center" style={{height:guidance().length*14,hitPass:1}}>{guidance().join('\n')}</Text>
  <Text class="absolute left-[8] right-[8] text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetT:66+guidance().length*14,height:status().length*11,hitPass:1}}>{status().join('\n')}</Text>
 </View>;
}
