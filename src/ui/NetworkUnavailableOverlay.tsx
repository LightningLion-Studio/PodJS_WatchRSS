import {FocusScope,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo,type JSX} from 'solid-js';
import type {InternetStatus} from '../onboarding/state.ts';
import {networkMessages,NetworkAvailabilityStatusBar,OnboardingPrimaryButton} from './OnboardingNetworkScreen.tsx';
import {watchUiLines} from './text-layout.ts';

/** Same type, copy, colors and indicator as onboarding/Compose.
 * Geometry uses a 233-unit canvas. Every visible rectangle fits the safe circle. */
type NetworkStatusProps={width:number;height:number;rotation?:number;status:InternetStatus};
function NetworkStatusPage(props:NetworkStatusProps&{action:JSX.Element;opaque?:boolean}){
 const size=()=>Math.min(props.width,props.height),scale=()=>size()/233;
 const guidance=createMemo(()=>watchUiLines(networkMessages[props.status].guidance,{width:180,measure:t=>getOps().measureText(t,0)}));
 const status=createMemo(()=>watchUiLines(networkMessages[props.status].status,{width:190,measure:t=>getOps().measureText(t,19)}));
 const barTop=()=>57+guidance().length*14+(props.status==='bluetooth'?12:18);
 return <View class={props.opaque?"absolute inset-0 bg-[#000000]":"absolute inset-0 bg-[#000000f0]"}
  onPress={()=>{}} accessibilityLabel="互联网"><View class="absolute" style={{insetL:(props.width-233)/2,insetT:(props.height-233)/2,width:233,height:233,scale:scale(),rotate:props.rotation??0}}>
   <Text class="absolute left-[71.5] top-[18] w-[90] h-[29] text-2xl leading-[29] text-[#f5f5f5] text-center">互联网</Text>
   <Text class="absolute text-xs leading-[14] text-[#f5f5f5] text-center" style={{insetL:26.5,insetT:57,width:180,height:guidance().length*14}}>{guidance().join('\n')}</Text>
   <View class="absolute h-[42]" style={{insetL:12.5,insetT:barTop(),width:208}}><NetworkAvailabilityStatusBar status={props.status}/></View>
   <Text class="absolute text-[9px] leading-[11] text-[#b6b6b6] text-center" style={{insetL:21.5,insetT:barTop()+50,width:190,height:status().length*11}}>{status().join('\n')}</Text>
   <View class="absolute top-[174] left-[60.5] w-[112] h-[42] items-center justify-center">{props.action}</View>
  </View></View>;
}
export function NetworkUnavailableOverlay(props:NetworkStatusProps&{round?:boolean;onAction:()=>void}){
 return <NetworkStatusPage width={props.width} height={props.height} rotation={props.rotation} status={props.status}
  action={<OnboardingPrimaryButton text="重试" enabled={props.status!=='checking'} onPress={props.onAction}/>}/>;
}
export function BluetoothWarningPage(props:{width:number;height:number;rotation?:number;onBack:()=>void}){
 return <FocusScope class="absolute inset-0">
  <NetworkStatusPage width={props.width} height={props.height} rotation={props.rotation} status="bluetooth" opaque
   action={<OnboardingPrimaryButton text="继续" enabled allowTouchWhenBlocked onPress={props.onBack}/>}/>
 </FocusScope>;
}
