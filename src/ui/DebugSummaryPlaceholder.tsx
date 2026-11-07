import {createMemo,createSignal,onCleanup} from 'solid-js';
import {Image,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {debugGate} from '../debug/host.ts';
import {DebugSummary} from '../debug/summary.ts';
import {summaryTokenUsageText,type SummaryState} from '../llm/summary.ts';
import {watchUiLines} from './text-layout.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';
import type {AppServices} from './service.ts';

/** Native LlmSummaryScreen (debug-only LlmSummaryActivity, item_id > 0): pure black, crown scroll,
 * 18dp safe padding. Title row: AutoAwesome 16dp + 6dp + "AI 总结" (titleSmall 14/20). Generating
 * spinner 14dp/1.5dp with 8dp gap; state text indented 10dp. Content card 12dp radius, surfaceVariant,
 * 12/10dp padding, bodyMedium 14/20. Token card 10dp radius, surfaceVariant .6, 12/8dp padding, label/value
 * 4dp apart. Error card 12dp radius, #FF6B6B at .12, centred "生成失败" + bodySmall reason, "重试" pill 8dp below. */
const SURFACE_VARIANT='#2a2a2a',ON_SURFACE='#f5f5f5',ON_SURFACE_VARIANT='#b6b6b6',ERROR='#ff6b6b';
const BODY_SLOT=1,SMALL_SLOT=0,TITLE_SLOT=1;
export function DebugSummaryPlaceholder(props:{id:string;width:number;height:number;active:()=>boolean;services:AppServices;preset:()=>number;showTokens:()=>boolean}){
 if(!debugGate.allowed)return null;
 const [state,setState]=createSignal<SummaryState>({status:'idle',text:''});
 const summary=new DebugSummary(debugGate,(...args)=>props.services.createSummary(...args));
 summary.open(props.id,props.preset,setState);onCleanup(()=>summary.dispose());
 const inner=()=>props.width-36;
 const wrap=(text:string,width:number,slot:number)=>watchUiLines(text,{width:Math.max(1,width),measure:value=>getOps().measureText(value,slot)});
 const gap=(height:number):ScrollEntry=>({height,render:()=>null});
 const statusText=()=>state().status==='waiting'?'原文还在加载，准备好后会自动开始总结。':state().status==='generating'?'正在生成总结...':'准备中...';
 const entries=createMemo<ScrollEntry[]>(()=>{
  const current=state(),rows:ScrollEntry[]=[gap(6)];
  rows.push({height:20,render:()=> <View class="absolute inset-0">
   <Image src="../assets/icons/ai-summary.svg" class="absolute left-[0] top-[2] w-[16] h-[16]"/>
   <Text class="absolute left-[22] top-[0] text-sm leading-[20]" style={{fontSlot:TITLE_SLOT,textColor:ON_SURFACE}}>AI 总结</Text>
  </View>});
  rows.push(gap(8));
  if(current.status==='done'){
   const lines=wrap(current.text,inner()-24,BODY_SLOT);
   rows.push({height:20+lines.length*20,render:()=> <View class="absolute inset-0 rounded-[12]" style={{bgColor:SURFACE_VARIANT}}>
    <Text class="absolute left-[12] right-[12] top-[10] text-sm leading-[20]" style={{fontSlot:BODY_SLOT,textColor:ON_SURFACE}}>{lines.join('\n')}</Text>
   </View>});
   const usage=summaryTokenUsageText(current,props.showTokens());
   if(usage){
    const usageLines=wrap(usage,inner()-24,SMALL_SLOT);
    rows.push(gap(8),{height:16+14+4+usageLines.length*14,render:()=> <View class="absolute inset-0 rounded-[10]" style={{bgColor:SURFACE_VARIANT+'99'}}>
     <Text class="absolute left-[12] right-[12] top-[8] text-xs leading-[14]" style={{textColor:ON_SURFACE_VARIANT}}>Token 用量</Text>
     <Text class="absolute left-[12] right-[12] top-[26] text-xs leading-[14]" style={{textColor:ON_SURFACE}}>{usageLines.join('\n')}</Text>
    </View>});
   }
  }else if(current.status==='error'){
   const reason=wrap(current.error?.trim()||'未知错误',inner()-24,SMALL_SLOT);
   rows.push({height:20+20+4+reason.length*14,render:()=> <View class="absolute inset-0 rounded-[12]" style={{bgColor:ERROR+'1f'}}>
    <Text class="absolute left-[12] right-[12] top-[10] text-sm leading-[20] text-center" style={{textColor:ERROR}}>生成失败</Text>
    <Text class="absolute left-[12] right-[12] top-[34] text-xs leading-[14] text-center" style={{textColor:ON_SURFACE_VARIANT}}>{reason.join('\n')}</Text>
   </View>});
   const pill=Math.min(160,inner()-18);
   rows.push(gap(8),{height:48,render:()=> <View class="absolute top-[0] h-[48] rounded-[24] items-center justify-center active:scale-96" style={{insetL:(inner()-pill)/2,width:pill,bgColor:SURFACE_VARIANT}}
    focusable accessibilityRole="button" accessibilityLabel="重试" onPress={()=>{if(props.active())void summary.retry();}}>
    <Text class="text-[17px] leading-[23]" style={{textColor:ON_SURFACE}}>重试</Text>
   </View>});
  }else{
   const lines=wrap(statusText(),inner()-10-(current.status==='generating'?22:0),SMALL_SLOT);
   rows.push({height:Math.max(14,lines.length*14),render:()=> <View class="absolute inset-0">
    {current.status==='generating'?<View class="absolute left-[10] top-[0] w-[14] h-[14]"><WatchProgressIndicator size={14} strokeWidth={1.5} color={ON_SURFACE_VARIANT} trackColor="#00000000" active={props.active} accessibilityLabel="正在生成总结"/></View>:null}
    <Text class="absolute right-[0] top-[0] text-xs leading-[14]" style={{insetL:current.status==='generating'?32:10,textColor:ON_SURFACE_VARIANT}}>{lines.join('\n')}</Text>
   </View>});
  }
  rows.push(gap(48));
  return rows;
 });
 return <View class="absolute inset-0 bg-[#000000]"><ScrollEntries height={props.height} entries={entries()} padding={18} gap={0} inputActive={props.active} accessibilityLabel="AI 总结"/></View>;
}
