import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo} from 'solid-js';
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
/** Only this compact card handles its own tap; there is no full-screen hit target.
 * An opaque plate (8-unit padding, 196 wide) keeps the copy legible over lists;
 * its corners stay inside the 233-unit safe circle for 1-2 line guidance. */
export function NetworkBluetoothNotice(props:{width:number;height:number;onDismiss:()=>void}){
 const scale=()=>Math.min(props.width,props.height)/233;
 const guidance=createMemo(()=>watchUiLines(networkMessages.bluetooth.guidance,{width:180,measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(networkMessages.bluetooth.status,{width:180,measure:t=>getOps().measureText(t,19)}));
 const height=()=>66+guidance().length*14+8+status().length*11;
 return <View class="absolute rounded-[24] bg-[#0b0c0df5]" style={{insetL:props.width/2-98*scale(),insetT:props.height/2-height()*scale()/2,width:196,height:height(),scale:scale(),originX:-.5,originY:-.5}} onPress={props.onDismiss} accessibilityLabel={networkMessages.bluetooth.guidance}>
  <View class="absolute left-[8] right-[8] top-[8] h-[42]"><NetworkAvailabilityStatusBar status="bluetooth"/></View>
  <Text class="absolute left-[8] right-[8] top-[58] text-xs leading-[14] text-[#f5f5f5] text-center" style={{height:guidance().length*14}}>{guidance().join('\n')}</Text>
  <Text class="absolute left-[8] right-[8] text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetT:66+guidance().length*14,height:status().length*11}}>{status().join('\n')}</Text>
 </View>;
}
