import {Text,View} from '@pocketjs/framework/components';
import {createSignal,onCleanup,onMount} from 'solid-js';
import {LogUploadController,type LogUploadOptions,type LogUploadState} from '../logs/upload.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';

/** Standalone: lead owns privacy-screen callback and route wiring.
 * options are explicit so mounting a fixture cannot accidentally contact production. */
export function LogUploadScreen(props:{height:number;options:LogUploadOptions;active?:()=>boolean}) {
  const [state,setState]=createSignal<LogUploadState>({phase:'loading',message:'加载中...'});
  const controller=new LogUploadController(props.options,setState);
  onMount(()=>{void controller.start();});
  onCleanup(()=>controller.dispose());
  const row=(text:string,height=52):ScrollEntry=>({height,render:()=> <View class="absolute inset-0 items-center justify-center"><Text class="text-[17px] leading-[22] text-[#f5f5f5]">{text}</Text></View>});
  const entries=():ScrollEntry[]=>{
    const s=state();
    return [row(s.phase==='load-error'?'加载失败':'日志上传器',40),row(s.message,88),...(s.phase==='success'?[row('我的日志',38),row(`取件码：${s.code}`),row(s.record.createdAt),row(`文件大小：${s.record.fileSize} B`),row(`字符数：${s.record.charCount}`)]:[])];
  };
  return <ScrollEntries height={props.height} entries={entries()} padding={24} inputActive={props.active} accessibilityLabel="日志上传"/>;
}
