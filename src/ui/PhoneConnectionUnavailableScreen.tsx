import {createMemo} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {phonePageText} from './phone-connection-layout.ts';

/** Native has no buttons or scroll container; the caller owns system back. */
export function PhoneConnectionUnavailableScreen(props:{width:number;height:number;message:string}){
 const measure=(text:string,slot:number)=>getOps().measureText(text,slot);
 const title=createMemo(()=>phonePageText('暂不可用','title',props.width-36,measure));
 const message=createMemo(()=>phonePageText(props.message,'small',props.width-36,measure));
 const top=()=>18+(props.height-36-title().height-message().height)/2;
 // Compose centers the Text node; its multiline paragraph retains Start alignment.
 const width=()=>Math.min(props.width-36,Math.max(...message().text.split('\n').map(text=>measure(text,0))));
 return <View class="absolute inset-0 bg-black">
  <Text class="absolute left-[18] right-[18] text-center text-[#f5f5f5]" style={{insetT:top(),height:title().height,fontSlot:23,lineHeight:26}}>{title().text}</Text>
  <Text class="absolute text-[#b6b6b6]" style={{insetL:(props.width-width())/2,insetT:top()+title().height,width:width(),height:message().height,fontSlot:0,lineHeight:14}}>{message().text}</Text>
 </View>;
}
