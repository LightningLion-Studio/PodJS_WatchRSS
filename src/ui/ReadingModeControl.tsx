import {Text,View} from '@pocketjs/framework/components';
/** One persisted reading-mode selection, shared by settings and reader controls. */
export function ReadingModeControl(props:{width:number;height?:number;pageMode:boolean;onChange:(value:boolean)=>void}) {
 return <View accessibilityLabel="翻页模式" class="relative rounded-[20] bg-[#23272a]" style={{width:props.width,height:props.height??40}}>
  {[{value:false,label:'纵向滚动'},{value:true,label:'点击翻页'}].map((option,index)=><View accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{selected:props.pageMode===option.value}} focusable onPress={()=>props.onChange(option.value)} class="absolute top-[3] rounded-[17] items-center justify-center" style={{height:(props.height??40)-6,insetL:3+index*(props.width-6)/2,width:(props.width-6)/2,bgColor:props.pageMode===option.value?'#ff6026':'#23272a'}}><Text class="text-xs" style={{textColor:props.pageMode===option.value?'#000000':'#f5f5f5'}}>{option.label}</Text></View>)}
 </View>;
}
