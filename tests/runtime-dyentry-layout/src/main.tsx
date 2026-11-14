import {mount} from '@pocketjs/framework/solid';
import {createSignal} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {traceServiceWork,__setServiceTraceEnabled} from '@podjs/framework/service-trace';
import {ImmersiveEntryContent} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import type {DouyinEntryState} from '../../../src/ui/douyin/entry-layout.ts';
const metrics=getDisplayMetrics();
__setServiceTraceEnabled(true);
const states:DouyinEntryState[]=[
 {auth:'logged-in',hasItems:false,busy:true,slow:false,error:''},
 {auth:'logged-in',hasItems:false,busy:true,slow:true,error:''},
 {auth:'logged-in',hasItems:false,busy:false,slow:false,error:'内容加载超时'},
 {auth:'logged-out',hasItems:false,busy:false,slow:false,error:''},
 {auth:'logged-in',hasItems:false,busy:false,slow:false,error:'网络请求失败，请稍后重试'},
 {auth:'logged-in',hasItems:true,busy:false,slow:false,error:''},
 {auth:'unknown',hasItems:false,busy:true,slow:false,error:''},
];
// This key exists only in the test app's private KV file. The driver restarts the
// process for every case, so native atlas reuse cannot conceal missing content.
const index=Math.max(0,Math.min(states.length*2-1,kv.get<number>('dyentry.layout.case')??0));
const [state,setState]=createSignal(states[Math.floor(index/2)]);
// No account, network client or HTTP transport is constructed.
mount(()=> <ImmersiveEntryContent auth={state().auth} hasItems={state().hasItems} busy={state().busy} slow={state().slow} error={state().error}
 width={metrics.logicalWidth} height={metrics.logicalHeight} showNotice={index%2===0} onInfo={()=>{if(index>=12){setState(states[5]);traceServiceWork('dyentry.layout.auth-ready',()=>{},index);}}} onEnter={()=>{}} onRetry={()=>{
 setState(states[0]);traceServiceWork('dyentry.layout.retry',()=>{},index);
 }}/>);
traceServiceWork('dyentry.layout.case',()=>{},index);
