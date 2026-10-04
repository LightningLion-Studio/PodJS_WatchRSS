import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {createSignal} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {textLayout} from '@podjs/framework/services';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {requestReaderLayoutBatched} from '../../src/reader/platform-layout.ts';
import type {ContentBlock} from '../../src/reader/content.ts';

const [status,setStatus]=createSignal('排版测试');
mount(()=><View class="absolute inset-0 items-center justify-center bg-black"><Text class="text-sm text-white">{status()}</Text></View>);
const blocks:ContentBlock[]=Array.from({length:120},(_,index)=>({type:'text',style:'body',text:`第 ${index+1} 段。这是一段用于验证备忘录原生文字排版的固定内容。`}));
const preset=defaultReaderPreset('note-light','Light',false,20);
const metrics=getDisplayMetrics(),scale=metrics.physicalWidth/metrics.logicalWidth;
const started=Date.now(),publications:{blocks:number;elapsedMs:number}[]=[],errors:string[]=[];
const task=requestReaderLayoutBatched(blocks,metrics.logicalWidth-28,preset.body.fontSizeSp,scale,preset,
 args=>textLayout.layoutBatch(args),
 layouts=>{publications.push({blocks:layouts.size,elapsedMs:Date.now()-started});setStatus(`已排版 ${layouts.size}/120`);},
 error=>errors.push(String(error)),undefined,{firstBlocks:4,batchBlocks:16});
void task.done.then(()=>kv.set('note-layout-progress',{blocks:blocks.length,publications,errors,elapsedMs:Date.now()-started}));
