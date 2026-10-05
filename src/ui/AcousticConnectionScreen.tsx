import {createSignal,createEffect,createMemo,onCleanup} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {onLifecycleChange} from '@podjs/framework/watch';
import {base64ToBytes} from '@podjs/framework/services';
import {createAcousticConnection} from '../phoneconnection/host.ts';
import {abilities,type Ability,type AcousticMode} from '../phoneconnection/protocol.ts';
import type {AcousticState} from '../phoneconnection/session.ts';
import {debugGate} from '../debug/host.ts';
import {PHONE_PAGE,phonePageText,type PhoneTextKind} from './phone-connection-layout.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';
import type {RouteEntry} from './routes/types.ts';
import type {AppServices} from './service.ts';

const MODE_TITLE:Record<AcousticMode,string>={PURE_SOUND:'纯声波',SOUND_GUIDED_WIFI:'声波引导 WiFi'};
/** AcousticConnectionActivity.kt formatDuration. */
function formatDuration(ms:number){const total=Math.ceil(ms/1000),m=Math.floor(total/60),s=total%60;return m>0?`${m}分${s}秒`:`${s}秒`;}
/** AcousticConnectionActivity.kt primaryButtonLabel per mode/ability. */
function primaryLabel(mode:AcousticMode,ability:Ability){
 if(mode==='SOUND_GUIDED_WIFI')return '开始监听并连接';
 return ability==='REMOTE_INPUT'?'开始监听':'开始发送';
}

/** Native AcousticConnectionScreen (debug only): pure-black page, centred titleMedium mode title,
 * bodySmall current ability, bodyMedium status + bodySmall detail/ETA, Material3 pill buttons.
 * The mode/ability pickers below replace the native intent extras this debug entry cannot pass. */
export function AcousticConnectionScreen(props:{width:number;height:number;active:()=>boolean;entry:RouteEntry;services:AppServices;onUrl?:(url:string)=>void}){
 debugGate.require();
 const [mode,setMode]=createSignal<AcousticMode>('SOUND_GUIDED_WIFI'),[ability,setAbility]=createSignal<Ability>('REMOTE_INPUT');
 const [state,setState]=createSignal<AcousticState>({phase:'idle',message:'选择声波连接方式',busy:false,canStart:true});
 let alive=true;
 const session=createAcousticConnection(next=>{if(alive)setState(next);},props.onUrl);
 const choose=()=>{if(props.active())void session.select(mode(),ability());};
 onCleanup(onLifecycleChange(value=>{if(value!=='active')void session.cancel();}));
 createEffect(()=>{if(!props.active())void session.cancel();});
 onCleanup(()=>{alive=false;void session.cancel();});
 choose();

 const inner=()=>props.width-PHONE_PAGE.padding*2;
 const measure=(text:string,slot:number)=>getOps().measureText(text,slot);
 const textRow=(text:string,kind:PhoneTextKind):ScrollEntry=>{
  const line=phonePageText(text,kind,inner(),measure);
  return {height:line.height,render:()=> <Text class="absolute inset-0 text-center" style={{fontSlot:line.slot,lineHeight:line.lineHeight,textColor:line.color}}>{line.text}</Text>};
 };
 const button=(label:string,press:()=>void,primary:boolean):ScrollEntry=>({height:PHONE_PAGE.touchHeight,render:()=>{
  const width=Math.min(inner(),Math.max(58,measure(label,1)+48));
  return <View class="absolute top-[0] h-[48]" style={{insetL:(inner()-width)/2,width}} focusable accessibilityRole="button" accessibilityLabel={label} onPress={()=>{if(props.active())press();}}>
   <View class="absolute left-[0] right-[0] top-[4] h-[40] rounded-[20] items-center justify-center" style={{bgColor:primary?PHONE_PAGE.primary:'#2a2a2a'}}><Text class="text-sm leading-[17]" style={{textColor:primary?PHONE_PAGE.onPrimary:PHONE_PAGE.foreground}}>{label}</Text></View>
  </View>;
 }});
 /** WatchSettingsPillRow: #2A2A2A 52dp pill, 17/21 label, secondary value on the right. */
 const pill=(label:string,value:string,press:()=>void):ScrollEntry=>({height:52,render:()=>{
  const valueWidth=Math.min(inner()/2,measure(value,0)+4);
  return <View class="absolute inset-0 rounded-[26] bg-[#2a2a2a]" focusable accessibilityRole="button" accessibilityLabel={`${label} ${value}`} onPress={()=>{if(props.active()&&!state().busy)press();}}>
   <Text class="absolute left-[16] top-[15] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
   <Text class="absolute right-[16] top-[19] text-xs leading-[14] text-right text-[#b6b6b6]" style={{width:valueWidth}}>{value}</Text>
  </View>;
 }});
 const abilityKeys=Object.keys(abilities) as Ability[];
 const entries=createMemo<ScrollEntry[]>(()=>{
  const current=state(),rows=[textRow(MODE_TITLE[mode()],'title'),textRow(`当前操作：${abilities[ability()].displayName}`,'small')];
  if(current.busy)rows.push({height:PHONE_PAGE.progressSize,render:()=> <View class="absolute inset-0 items-center"><WatchProgressIndicator size={PHONE_PAGE.progressSize} strokeWidth={PHONE_PAGE.progressStroke} color={PHONE_PAGE.primary} trackColor="#00000000" active={props.active} accessibilityLabel={current.message}/></View>});
  rows.push(textRow(current.message,'body'));
  if(current.detail?.trim())rows.push(textRow(current.detail,'small'));
  if(current.durationMs)rows.push(textRow(`预计耗时 ${formatDuration(current.durationMs)}`,'small'));
  if(current.busy)rows.push(button('停止',()=>{void session.cancel();},false));
  else if(current.canStart)rows.push(button(primaryLabel(mode(),ability()),()=>{void session.start();},true));
  if(!current.busy){
   rows.push(textRow('调试选项','small'));
   rows.push(pill('连接方式',MODE_TITLE[mode()],()=>{setMode(mode()==='PURE_SOUND'?'SOUND_GUIDED_WIFI':'PURE_SOUND');choose();}));
   rows.push(pill('操作',abilities[ability()].displayName,()=>{setAbility(abilityKeys[(abilityKeys.indexOf(ability())+1)%abilityKeys.length]);choose();}));
   rows.push(pill('引导 payload','Base64',()=>{void props.services.input('引导 payload Base64','').then(value=>{if(!alive||!props.active()||value===null)return;try{void session.debugGuidedPayload(base64ToBytes(value));}catch(error){setState({phase:'error',message:String(error),busy:false,canStart:true});}}).catch(error=>{if(alive)setState({phase:'error',message:String(error),busy:false,canStart:true});});}));
  }
  return rows;
 });
 return <View class="absolute inset-0 bg-black"><ScrollEntries height={props.height} entries={entries()} padding={PHONE_PAGE.padding} gap={PHONE_PAGE.gap} inputActive={props.active} ref={value=>{props.entry.list=value;}} accessibilityLabel="声波连接"/></View>;
}
