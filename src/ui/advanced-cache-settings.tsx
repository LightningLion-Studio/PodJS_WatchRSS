import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {CACHE_OPTIONS_MB,MEDIA_CACHE_OPTIONS} from '../settings/store.ts';
import {cacheSizeLabel,cachePrefetchMode} from '../cache/policy.ts';
import {watchUiLines} from './text-layout.ts';
import {WatchSwitch} from './AutoScrollSettingsScreen.tsx';
import type {SettingsScreenProps} from './SettingsScreen.tsx';
import type {ScrollEntry} from './ScrollEntries.tsx';
import {describedRows} from './round-rows.tsx';
export function advancedCacheRows(props:SettingsScreenProps,width:number,usage:number|undefined):ScrollEntry[]{
 const wrap=(text:string,w:number,slot=0)=>watchUiLines(text,{width:w,measure:t=>getOps().measureText(t,slot)});
 const entry=(label:string,details:string[],controlWidth:number,control:()=>unknown):ScrollEntry[]=>{
  const labelWidth=width-20-controlWidth,labelLines=wrap(label,labelWidth,22),height=Math.max(52,labelLines.length*21+16);
  return describedRows(width,{height,render:()=> <View class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{height}}><Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{insetT:(height-labelLines.length*21)/2,width:labelWidth}}>{labelLines.join('\n')}</Text><View class="absolute right-[10]" style={{width:controlWidth,insetT:(height-21)/2,height:21}}>{control() as any}</View></View>},details.map(text=>wrap(text,width-10)));
 };
 const button=(plus:boolean,enabled:boolean,action:()=>void)=><View focusable={enabled} onPress={enabled?action:undefined} class="absolute top-[0.5] w-[20] h-[20] rounded-full bg-[#444444] active:scale-96" style={{insetL:plus?80:0,opacity:enabled?1:.38}}><View class="absolute left-[5] top-[9.5] w-[10] h-[1] bg-[#f5f5f5]"/>{plus?<View class="absolute left-[9.5] top-[5] w-[1] h-[10] bg-[#f5f5f5]"/>:null}</View>;
 const step=(value:string,lower:boolean,higher:boolean,dec:()=>void,inc:()=>void)=><>{button(false,lower,dec)}<Text class="absolute left-[24] top-[0] w-[52] text-center text-[17px] leading-[21] text-[#f5f5f5]">{value}</Text>{button(true,higher,inc)}</>;
 const lower=CACHE_OPTIONS_MB.filter(v=>v<props.state.cacheLimitMb).at(-1),higher=CACHE_OPTIONS_MB.find(v=>v>props.state.cacheLimitMb),mode=MEDIA_CACHE_OPTIONS.indexOf(props.state.mediaCacheMode),prefetch=cachePrefetchMode(props.state.mediaCacheMode);
 const changeLimit=(direction:-1|1)=>{const options=CACHE_OPTIONS_MB.filter(v=>direction<0?v<props.state.cacheLimitMb:v>props.state.cacheLimitMb),value=direction<0?options.at(-1):options[0];if(value!==undefined)props.onChange({cacheLimitMb:value});};
 const changeMode=(direction:-1|1)=>{const value=MEDIA_CACHE_OPTIONS[MEDIA_CACHE_OPTIONS.indexOf(props.state.mediaCacheMode)+direction];if(value!==undefined)props.onChange({mediaCacheMode:value});};
 return [...entry('缓存上限',[usage===undefined?'正在读取缓存用量':`当前已用 ${cacheSizeLabel(Math.floor(usage/1024/1024))}`,'包含图片、预览和离线媒体；离线媒体不会自动清理'],100,()=>step(cacheSizeLabel(props.state.cacheLimitMb),lower!==undefined,higher!==undefined,()=>changeLimit(-1),()=>changeLimit(1))),
 ...entry('媒体缓存',[prefetch.summary,'用于原文媒体内容；默认推荐保留前 4 项'],100,()=>step(prefetch.label,mode>0,mode<MEDIA_CACHE_OPTIONS.length-1,()=>changeMode(-1),()=>changeMode(1))),
 ...entry('同步媒体保活',[props.state.syncMediaKeepAlive?'已开启':'已关闭（默认）','连接建立后至同步结束播放无声音频，熄屏传输更稳定；会增加同步期间耗电'],65/getDisplayMetrics().density,()=> <View class="absolute left-[0]" style={{insetT:(21-35/getDisplayMetrics().density)/2}}><WatchSwitch checked={props.state.syncMediaKeepAlive} onChange={()=>props.onChange({syncMediaKeepAlive:!props.state.syncMediaKeepAlive})}/></View>)];
}
