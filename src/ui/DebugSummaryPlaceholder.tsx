import {createSignal,onCleanup} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {debugGate} from '../debug/host.ts';
import {DebugSummary} from '../debug/summary.ts';
import {summaryDisplayText,summaryTokenUsageText,type SummaryState} from '../llm/summary.ts';
import type {AppServices} from './service.ts';
export function DebugSummaryPlaceholder(props:{id:string;services:AppServices;preset:()=>number;showTokens:()=>boolean}){
 if(!debugGate.allowed)return null;
 const [state,setState]=createSignal<SummaryState>({status:'idle',text:''});
 const summary=new DebugSummary(debugGate,(...args)=>props.services.createSummary(...args));
 summary.open(props.id,props.preset,setState);onCleanup(()=>summary.dispose());
 return <View class="absolute inset-0 bg-[#000000]" onPress={()=>{if(state().status==='error')void summary.retry();}}><Text class="text-sm text-[#ffffff]">{'AI 总结（布局待接入）\n'+summaryDisplayText(state())+'\n'+(summaryTokenUsageText(state(),props.showTokens())??'')}</Text></View>;
}
