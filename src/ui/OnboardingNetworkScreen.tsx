import {Image,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo,Show} from 'solid-js';
import type {InternetStatus} from '../onboarding/state.ts';
import {watchUiLines} from './text-layout.ts';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';

const messages:Record<InternetStatus,{guidance:string;status:string}>={
 checking:{guidance:'正在检测网络连接',status:'正在检测互联网状态...'},
 unavailable:{guidance:'请连接 WiFi 或移动网络',status:'未检测到可用互联网'},
 bluetooth:{guidance:'当前使用蓝牙网络，网速较慢，建议连接 WiFi 或移动网络',status:'已连接蓝牙网络，可能影响加载速度'},
 available:{guidance:'网络连接可用',status:'已检测到互联网，可以继续'}
};

export function OnboardingPrimaryButton(props:{text:string;enabled:boolean;onPress:()=>void}){
 return <View focusable={props.enabled} accessibilityRole="button" accessibilityState={{disabled:!props.enabled}} onPress={()=>{if(props.enabled)props.onPress();}} class="rounded-[24] px-[22] py-[12] items-center justify-center" style={{bgColor:props.enabled?'#ff6026':'#23272a'}}><Text class="text-lg leading-[21]" style={{textColor:props.enabled?'#000000':'#b6b6b6'}}>{props.text}</Text></View>;
}

function NetworkIndicator(props:{status:InternetStatus;active?:()=>boolean}){
 return <View class="relative w-[18] h-[18]">
  <Show when={props.status==='checking'} fallback={<View class="absolute inset-0 rounded-[9999]" style={{bgColor:props.status==='available'?'#41c96b':props.status==='bluetooth'?'#ffa726':'#e54d4d'}}/>}>
   <WatchProgressIndicator size={18} strokeWidth={3} active={props.active} accessibilityLabel="正在检测互联网状态"/>
  </Show>
 </View>;
}

/** Receives monitor state from its owner; visiting the page cannot persist consent. */
export function OnboardingNetworkScreen(props:{width:number;height:number;status:InternetStatus;onContinue:()=>void;active?:()=>boolean}){
 const textWidth=()=>Math.min(props.width*.92,208);
 const guidanceWidth=()=>Math.min(props.width*.98,224);
 const long=()=>props.status==='bluetooth';
 // UI font slots: 0 is 12 px and 19 is 9 px. Explicit line wrapping keeps the
 // status row below long Bluetooth guidance instead of overlapping it.
 const guidance=createMemo(()=>watchUiLines(messages[props.status].guidance,{width:guidanceWidth(),measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(messages[props.status].status,{width:textWidth(),measure:t=>getOps().measureText(t,19)}));
 const guidanceTop=()=>(long()?10:18)+29+(long()?8:10);
 const barTop=()=>guidanceTop()+guidance().length*14+(long()?12:18);
 return <View class="absolute inset-0">
  <Text class="absolute left-[0] right-[0] text-2xl leading-[29] text-[#f5f5f5] text-center" style={{insetT:long()?10:18}}>互联网</Text>
  <Text class="absolute text-xs leading-[14] text-[#f5f5f5] text-center" style={{insetL:(props.width-guidanceWidth())/2,insetT:guidanceTop(),width:guidanceWidth(),height:guidance().length*14}}>{guidance().join('\n')}</Text>
  <View class="absolute h-[42] rounded-[22] bg-[#23272aeb]" style={{insetL:(props.width-textWidth())/2,insetT:barTop(),width:textWidth()}}>
   <Text class="absolute left-[16] top-[14] text-xs leading-[14] text-[#f5f5f5]">互联网可用状态</Text>
   <View class="absolute right-[16] top-[12]"><NetworkIndicator status={props.status} active={props.active}/></View>
  </View>
  <Text class="absolute text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetL:(props.width-textWidth())/2,insetT:barTop()+42+(long()?8:10),width:textWidth(),height:status().length*11}}>{status().join('\n')}</Text>
  <View class="absolute bottom-[0] left-[0] right-[0] flex-col items-center"><OnboardingPrimaryButton text="继续" enabled={props.status!=='checking'} onPress={props.onContinue}/></View>
 </View>;
}

export function OnboardingOfflineDialog(props:{width:number;height:number;status:InternetStatus;onConfirm:()=>void;onCancel:()=>void}){
 const size=()=>Math.min(props.width,props.height,466),scale=()=>size()/466;
 const lines=createMemo(()=>watchUiLines(props.status==='bluetooth'?messages.bluetooth.guidance:'你没有连接到互联网，确定要继续吗',{width:193,measure:t=>getOps().measureText(t,22)}));
 const top=()=>96+(204-(46*(1+lines().length)+8))/2;
 return <View class="absolute inset-0 bg-[#000000eb]" onPress={()=>{}}>
  <View class="absolute left-[0] top-[0] rounded-[9999] bg-black" style={{width:size(),height:size()}}>
   <Text class="absolute text-[17px] text-center text-[#f5f5f5]" style={{insetL:40*scale(),insetT:top()*scale(),width:193,height:23,lineHeight:23,scale:2*scale(),originX:-.5,originY:-.5}}>警告</Text>
   <Text class="absolute text-[17px] text-center text-[#b6b6b6]" style={{insetL:40*scale(),insetT:(top()+54)*scale(),width:193,height:23*lines().length,lineHeight:23,scale:2*scale(),originX:-.5,originY:-.5}}>{lines().join('\n')}</Text>
   <View focusable accessibilityLabel="取消" onPress={props.onCancel} class="absolute rounded-[9999] bg-[#23272a]" style={{insetL:113*scale(),insetT:332*scale(),width:104*scale(),height:104*scale()}}><Image src="../assets/icons/close.svg" class="absolute" style={{insetL:28*scale(),insetT:28*scale(),width:48*scale(),height:48*scale()}}/></View>
   <View focusable accessibilityLabel="确认继续" onPress={props.onConfirm} class="absolute rounded-[9999] bg-[#ff6026]" style={{insetL:249*scale(),insetT:332*scale(),width:104*scale(),height:104*scale()}}><Image src="../assets/icons/onboarding-check.svg" class="absolute" style={{insetL:28*scale(),insetT:28*scale(),width:48*scale(),height:48*scale()}}/></View>
  </View>
 </View>;
}
