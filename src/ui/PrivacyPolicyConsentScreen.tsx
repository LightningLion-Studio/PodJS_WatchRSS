import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {textLayout} from '@podjs/framework/services';
import {getDisplayMetrics,hasCapability} from '@podjs/framework/watch';
import {createEffect,createMemo,createSignal,onCleanup,Show} from 'solid-js';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {privacyConsentLayout,type ConsentLayout} from './privacy-consent-layout.ts';

type Row = ConsentLayout[keyof ConsentLayout];
const frame = (row: Row) => ({insetL:row.x,insetT:row.y,width:row.width,height:row.height});
function ConsentCaption(props:{row:Row;color:string}) {
 const caption=()=>props.row.caption;
 return <Text class="absolute text-center" accessibilityHidden style={{
  insetL:0,insetT:(props.row.height-caption().height)/2,width:props.row.width/caption().scale,
  fontSlot:caption().fontSlot,scale:caption().scale,originX:-.5,originY:-.5,
  lineHeight:caption().lineHeight/caption().scale,textColor:props.color,
 }}>{caption().lines.join('\n')}</Text>;
}

export function PrivacyPolicyConsentScreen(props:{
 width:number;height:number;
 onOpenPrivacy:()=>void;onAgree:()=>void;onDisagree:()=>void;
 active?:()=>boolean;ref?:Parameters<typeof ScrollEntries>[0]['ref'];
}){
 const [fontScale,setFontScale]=createSignal(1);
 createEffect(()=>{
  if(props.active?.()===false||!hasCapability('text.environment'))return;
  let current=true;
  onCleanup(()=>{current=false;});
  void textLayout.environment().then(({fontScale:scale})=>{
   if(current&&Number.isFinite(scale)&&scale>0)setFontScale(scale);
  }).catch(()=>{});
 });
 const round=getDisplayMetrics().shape==='round';
 const layout=createMemo(()=>privacyConsentLayout(props.width,props.height,round,fontScale(),
  (value,slot)=>getOps().measureText(value,slot)));
 const entries=createMemo<ScrollEntry[]>(()=>[{height:props.height,render:()=> <Show when={layout()}>{value=>
  <View class="absolute inset-0">
   <View class="absolute" style={frame(value().title)} accessibilityRole="header" accessibilityLabel={value().title.caption.text}>
    <ConsentCaption row={value().title} color="#ffffff"/>
   </View>
   <View class="absolute" style={frame(value().notice)} accessibilityRole="text" accessibilityLabel={value().notice.caption.text}>
    <ConsentCaption row={value().notice} color="#ffffff"/>
   </View>
   <View class="absolute active:scale-96" style={frame(value().link)} focusable onPress={props.onOpenPrivacy}
    accessibilityRole="link" accessibilityLabel={value().link.caption.text}>
    <ConsentCaption row={value().link} color="#ff6026"/>
    <View class="absolute bg-[#ff6026]" style={{
     insetL:(value().link.width-value().link.caption.width)/2,
     insetT:(value().link.height+value().link.caption.height)/2,width:value().link.caption.width,height:.5,
    }}/>
   </View>
   <View class="absolute rounded-[9999] bg-[#23272a] active:scale-96" style={frame(value().disagree)} focusable onPress={props.onDisagree}
    accessibilityRole="button" accessibilityLabel={value().disagree.caption.text}>
    <ConsentCaption row={value().disagree} color="#b6b6b6"/>
   </View>
   <View class="absolute rounded-[9999] bg-[#ff6026] active:scale-96" style={frame(value().agree)} focusable onPress={props.onAgree}
    accessibilityRole="button" accessibilityLabel={value().agree.caption.text}>
    <ConsentCaption row={value().agree} color="#000000"/>
   </View>
  </View>
 }</Show>}]);
 return <View class="absolute inset-0 bg-black" accessibilityState={{disabled:props.active?.()===false}}>
  <ScrollEntries fixed height={props.height} entries={entries()} padding={0} verticalPadding={0} gap={0} inputActive={props.active} ref={props.ref}/>
 </View>;
}
