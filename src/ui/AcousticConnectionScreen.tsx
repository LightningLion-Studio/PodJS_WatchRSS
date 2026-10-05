import {createSignal,createEffect,onCleanup} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {onLifecycleChange} from '@podjs/framework/watch';
import {base64ToBytes} from '@podjs/framework/services';
import {createAcousticConnection} from '../phoneconnection/host.ts';
import {abilities,type Ability,type AcousticMode} from '../phoneconnection/protocol.ts';
import {debugGate} from '../debug/host.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import type {RouteEntry} from './routes/types.ts';
import type {AppServices} from './service.ts';
/** Temporary functional UI. Native visual parity is owned by lead. */
export function AcousticConnectionScreen(props:{height:number;active:()=>boolean;entry:RouteEntry;services:AppServices;onUrl?:(url:string)=>void}){
 debugGate.require();const [mode,setMode]=createSignal<AcousticMode>('SOUND_GUIDED_WIFI'),[ability,setAbility]=createSignal<Ability>('REMOTE_INPUT');
 const [status,setStatus]=createSignal('请选择模式和操作'),[busy,setBusy]=createSignal(false);
 let alive=true;
 const session=createAcousticConnection(state=>{if(alive){setStatus([state.message,state.detail,state.durationMs?`预计耗时 ${Math.ceil(state.durationMs/1000)} 秒`:null].filter(Boolean).join('\n'));setBusy(state.busy);}},props.onUrl);
 const choose=()=>{if(props.active())void session.select(mode(),ability());};
 onCleanup(onLifecycleChange(state=>{if(state!=='active')void session.cancel();}));
 createEffect(()=>{if(!props.active())void session.cancel();});
 onCleanup(()=>{alive=false;void session.cancel();});
 choose();
 const row=(label:string,action?:()=>void):ScrollEntry=>({height:56,render:()=> <View focusable={!!action} onPress={()=>{if(props.active())action?.();}} class="absolute inset-0 rounded-[16] bg-[#1c1f21] justify-center px-[12]"><Text class="text-sm text-white">{label}</Text></View>});
 const entries=():ScrollEntry[]=>[
  row('声波连接（调试）'),row(mode()==='PURE_SOUND'?'模式：纯声波':'模式：声波引导 WiFi',()=>{if(busy())return;setMode(mode()==='PURE_SOUND'?'SOUND_GUIDED_WIFI':'PURE_SOUND');choose();}),
  ...Object.entries(abilities).map(([key,value])=>row(`${key===ability()?'✓ ':''}${value.displayName}`,()=>{if(busy())return;setAbility(key as Ability);choose();})),
  ...status().split('\n').map(text=>row(text)),
  row(busy()?'停止':'开始',()=>{if(busy())void session.cancel();else void session.start();}),
  row('调试：输入引导 payload Base64',()=>{if(busy())return;void props.services.input('引导 payload Base64','').then(value=>{if(!alive||!props.active()||value===null)return;try{void session.debugGuidedPayload(base64ToBytes(value));}catch(error){setStatus(String(error));}}).catch(error=>{if(alive)setStatus(String(error));});}),
 ];
 return <ScrollEntries height={props.height} entries={entries()} inputActive={props.active} ref={value=>{props.entry.list=value;}}/>;
}
