import {Image,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {createMemo,For,Show,type JSX} from 'solid-js';
import type {IntroAction,IntroState} from '../onboarding/state.ts';
import type {CustomizationDraft} from '../onboarding/restoration.ts';
import {OnboardingCustomizationScreen} from './OnboardingCustomizationScreen.tsx';
import {OnboardingNetworkScreen,OnboardingOfflineDialog,OnboardingPrimaryButton} from './OnboardingNetworkScreen.tsx';
import {watchUiLines} from './text-layout.ts';

function IntroHero(props:{size:number}){
 const ring=()=>Math.min(props.size,Math.max(78,props.size*.84)),core=()=>Math.max(58,props.size*.66);
 return <View class="relative" style={{width:props.size,height:props.size}}>
  <Image src="../assets/icons/onboarding-glow.png" class="absolute inset-0"/>
  <View class="absolute rounded-[9999]" style={{insetL:(props.size-ring())/2,insetT:(props.size-ring())/2,width:ring(),height:ring(),borderWidth:1,borderColor:'#ff8a3d59'}}/>
  <View class="absolute rounded-[9999] items-center justify-center" style={{insetL:(props.size-core())/2,insetT:(props.size-core())/2,width:core(),height:core(),bgColor:'#1c1f21f0',borderWidth:1,borderColor:'#ff8a3d4d'}}><Text class="text-[23px] leading-[28] text-[#f5f5f5]">RSS</Text></View>
  <View class="absolute top-[16] right-[12] w-[10] h-[10] rounded-[9999] bg-[#ff8a3d]"/>
  <View class="absolute bottom-[16] left-[14] w-[7] h-[7] rounded-[9999] bg-[#ff8a3db3]"/>
 </View>;
}

const legalText='同意《用户协议》与《隐私政策》。';
const agreementError='请勾选"同意《用户协议》与《隐私政策》"';
function legalLayout(width:number){
 let index=0;
 return watchUiLines(legalText,{width:Math.max(1,width),measure:t=>getOps().measureText(t,0)}).map(line=>{
  const runs:{text:string;x:number;width:number;link:'useragreement'|'privacy'|null}[]=[];
  let x=0;
  for(const ch of line){const link=index>=2&&index<8?'useragreement':index>=9&&index<15?'privacy':null;
   const last=runs.at(-1);if(last&&last.link===link){last.text+=ch;last.width=getOps().measureText(last.text,0);x=last.x+last.width;}
   else{const width=getOps().measureText(ch,0);runs.push({text:ch,x,width,link});x+=width;}index++;
  }
  return runs;
 });
}

/** Four native intro pages. The owner retains state while legal documents are
 * pushed above this screen and supplies system-back/crown routing. No swipe
 * handler or persistence is installed by this presentation component. */
export function OnboardingScreen(props:{width:number;height:number;state:IntroState;onAction:(action:IntroAction)=>void;readerDark:boolean;onToggleReaderTheme:()=>void;onOpenLegal:(page:'useragreement'|'privacy')=>void;restoreCustomization?:()=>CustomizationDraft;saveCustomization?:(draft:CustomizationDraft)=>void;active?:()=>boolean;background?:JSX.Element;ref?:(handle:{onBack:()=>boolean;scroller:()=>Scroller|undefined})=>void}){
 let scroller:Scroller|undefined;
 const contentWidth=()=>props.width-36;
 const legal=createMemo(()=>legalLayout(contentWidth()-30));
 const errors=createMemo(()=>watchUiLines(agreementError,{width:contentWidth(),measure:t=>getOps().measureText(t,19)}));
 const agreementHeight=()=>Math.max(18,legal().length*14)+8+6+45+(props.state.agreementError?errors().length*11+8:0);
 const introHeight=()=>props.height-16-(props.state.page===0?2+8+45:8+agreementHeight());
 const hero=()=>props.state.page===0?Math.min(104,Math.max(82,introHeight()*.42)):Math.min(90,Math.max(74,introHeight()*.36));
 const next=()=>props.onAction({type:'next'});
 props.ref?.({onBack:()=>{if(props.state.page===0&&!props.state.offlineWarning)return false;props.onAction({type:'back'});return true;},scroller:()=>props.state.page===2?scroller:undefined});
 return <View class="absolute inset-0 bg-black" accessibilityState={{disabled:props.active?.()===false}}>
  <Show when={props.state.page!==2}>{props.background}</Show>
  <View class="absolute left-[18] right-[18] top-[8] bottom-[8]" accessibilityHidden={props.state.offlineWarning}>
   <Show when={props.state.page<2}>
    <View class="absolute left-[0] right-[0] flex-col items-center" style={{insetT:props.state.page===0?10:0}}>
     <IntroHero size={hero()}/>
     <Text class="text-sm leading-[17] text-[#ff8a3d]" style={{marginT:props.state.page===0?10:6}}>{props.state.page===0?'欢迎使用':'腕上RSS'}</Text>
     <Show when={props.state.page===0}><Text class="mt-[6] text-2xl leading-[29] text-[#f5f5f5] text-center">腕上RSS</Text></Show>
    </View>
    <View class="absolute bottom-[0] left-[0] right-[0] flex-col items-center">
     <Show when={props.state.page===1}>
      <Show when={props.state.agreementError}><Text class="text-[9px] leading-[11] text-[#e54d4d] mb-[8]" style={{width:Math.min(contentWidth(),Math.max(...errors().map(line=>getOps().measureText(line,19)))),height:errors().length*11}}>{errors().join('\n')}</Text></Show>
      <View class="relative mb-[6]" style={{width:contentWidth()-8,height:Math.max(18,legal().length*14)+8}}>
       <View focusable accessibilityRole="checkbox" accessibilityLabel="同意用户协议与隐私政策" accessibilityState={{checked:props.state.agreed}} onPress={()=>props.onAction({type:'agreement',agreed:!props.state.agreed})} class="absolute left-[0] w-[18] h-[18] rounded-[2]" style={{insetT:(Math.max(18,legal().length*14)+8-18)/2,bgColor:props.state.agreed?'#ff6026':'#00000000',borderWidth:2,borderColor:props.state.agreed?'#ff6026':'#b6b6b6'}}><Show when={props.state.agreed}><Image src="../assets/icons/onboarding-check.svg" class="absolute inset-0"/></Show></View>
       <For each={legal()}>{(runs,line)=><For each={runs}>{run=><View focusable={!!run.link} onPress={run.link?()=>props.onOpenLegal(run.link!):undefined} class="absolute" style={{insetL:22+run.x,insetT:4+line()*14,width:run.width,height:14}}><Text class={run.link?'absolute inset-0 text-xs leading-[14] text-[#ff6026]':'absolute inset-0 text-xs leading-[14] text-[#f5f5f5]'}>{run.text}</Text>{run.link&&<View class="absolute left-[0] right-[0] bottom-[0] h-[0.5] bg-[#ff6026]"/>}</View>}</For>}</For>
      </View>
     </Show>
     <OnboardingPrimaryButton text="下一页" enabled onPress={next}/>
    </View>
   </Show>
   <Show when={props.state.page===2}><OnboardingCustomizationScreen width={contentWidth()} height={props.height-16} readerDark={props.readerDark} onToggleReaderTheme={props.onToggleReaderTheme} onNext={next} restoreDraft={props.restoreCustomization} onDraftChange={props.saveCustomization} active={props.active} ref={value=>{scroller=value.scroller;}}/></Show>
   <Show when={props.state.page===3}><OnboardingNetworkScreen width={contentWidth()} height={props.height-16} status={props.state.internet} onContinue={next} active={()=>props.active?.()!==false&&!props.state.offlineWarning}/></Show>
  </View>
  <Show when={props.state.offlineWarning}><OnboardingOfflineDialog width={props.width} height={props.height} status={props.state.internet} onCancel={()=>props.onAction({type:'cancel-offline'})} onConfirm={()=>props.onAction({type:'confirm-offline'})}/></Show>
 </View>;
}
