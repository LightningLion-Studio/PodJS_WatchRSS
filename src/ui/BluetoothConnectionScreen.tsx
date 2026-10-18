import {hasCapability} from '@podjs/framework/watch';
import {createEffect,createMemo,createSignal,onCleanup} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {rfcomm,discovery} from '@podjs/framework/services';
import {BluetoothConnectionController,type BluetoothConnectionOptions,type BluetoothConnectionPorts,type BluetoothConnectionState} from './bluetooth-connection.ts';
import {PHONE_PAGE,phonePageText,type PhoneTextKind} from './phone-connection-layout.ts';
import {chunkLines} from './round-rows.tsx';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';

export interface BluetoothConnectionScreenProps extends BluetoothConnectionOptions {
 width:number;height:number;active:()=>boolean;
 /** Pass the existing application's Bluetooth runtime, never create one here. */
 sync:BluetoothConnectionPorts['sync'];
 radio?:BluetoothConnectionPorts['radio'];
 onDismiss:()=>void;
 ref?:(handle:{scroller:Scroller})=>void;
}
/** Standalone export; no navigation registration or listener ownership. */
export function BluetoothConnectionScreen(props:BluetoothConnectionScreenProps){
 const [state,setState]=createSignal<BluetoothConnectionState>({status:'等待手机蓝牙连接…',detail:null,busy:false});
 const controller=new BluetoothConnectionController({sync:props.sync,radio:props.radio??{status:()=>rfcomm.status(),requestPermission:async()=>{const value=await rfcomm.requestPermission().result;if(value==='granted'&&hasCapability('net.discovery'))await discovery.requestPermission();return value;}}},props,setState);
 createEffect(()=>controller.setActive(props.active()));
 onCleanup(()=>controller.dispose());
 const measure=(text:string,slot:number)=>getOps().measureText(text,slot);
 // Long explanations become several rows so each part can scroll fully into view on a round screen.
 const textRow=(text:string,kind:PhoneTextKind):ScrollEntry[]=>{
  const line=phonePageText(text,kind,props.width-36,measure);
  return chunkLines(line.text.split('\n'),line.lineHeight,props.width-36).map(lines=>({height:lines.length*line.lineHeight,render:()=> <Text class="absolute inset-0 text-center" style={{fontSlot:line.slot,lineHeight:line.lineHeight,textColor:line.color}}>{lines.join('\n')}</Text>}));
 };
 const button=(label:string,press:()=>void):ScrollEntry=>({height:PHONE_PAGE.touchHeight,render:()=>{
  const width=Math.min(props.width-36,Math.max(58,measure(label,1)+48));
  return <View class="absolute top-[0] h-[48]" style={{insetL:(props.width-36-width)/2,width}} focusable accessibilityRole="button" accessibilityLabel={label} onPress={()=>{if(props.active())press();}}>
   <View class="absolute left-[0] right-[0] top-[4] h-[40] rounded-[20] items-center justify-center" style={{bgColor:PHONE_PAGE.primary}}><Text class="text-sm leading-[17] text-black">{label}</Text></View>
  </View>;
 }});
 const entries=createMemo<ScrollEntry[]>(()=>{
  const current=state(),rows:ScrollEntry[]=[...textRow('蓝牙同步','title')];
  if(props.abilityLabel?.trim())rows.push(...textRow(`当前操作：${props.abilityLabel}`,'small'));
  if(current.busy)rows.push({height:40,render:()=> <View class="absolute inset-0 items-center"><WatchProgressIndicator size={40} strokeWidth={4} color={PHONE_PAGE.primary} trackColor="#00000000" active={props.active} accessibilityLabel="等待手机蓝牙连接"/></View>});
  rows.push(...textRow(current.status,'body'));
  if(current.detail!==null)rows.push(...textRow(current.detail,'small'));
  if(!current.busy)rows.push(button('重新等待',()=>{void controller.retry();}),button('关闭',props.onDismiss));
  return rows;
 });
 return <View class="absolute inset-0 bg-black"><ScrollEntries height={props.height} entries={entries()} padding={18} gap={8} inputActive={props.active} ref={props.ref} accessibilityLabel="蓝牙同步"/></View>;
}
