import {mount} from '@pocketjs/framework/solid';
import {createSignal,Show} from 'solid-js';
import {ReaderPreviewScreen} from '../../../src/ui/ReaderPreviewScreen.tsx';
import {ReaderBody} from '../../../src/ui/ReaderBody.tsx';
import type {ContentBlock} from '../../../src/reader/content.ts';
import {defaultReaderPreset,type ReaderPreset} from '../../../src/reader/preset.ts';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {systemTextResourceCounts} from '@podjs/framework/text';
const sleep=(ms:number)=>delay(ms).result;
const [current,setCurrent]=createSignal<{stage:string;preset:ReaderPreset;text:string;blocks:ContentBlock[]}|null>(null);
const text='Extraordinary internationalization and characterization demonstrate interoperability between independent implementations. Typography preserves every word.';
const variants=[['start','START','NONE','READABILITY'],['center','CENTER','NONE','READABILITY'],['justify','JUSTIFY','NONE','READABILITY'],['hyphen','START','AUTO','READABILITY'],['both','JUSTIFY','AUTO','READABILITY'],['animated','JUSTIFY','AUTO','LINEAR_SMOOTH']] as const;
async function run(){await sleep(1500);const before=JSON.stringify(kv.get('watchrss.reader-presets'));
 for(const mode of ['preview','body'])for(const [name,alignment,hyphenation,renderMode] of variants){
  const base=defaultReaderPreset('paragraph-only','Paragraph verification',true,14),preset={...base,body:{...base.body,alignment,hyphenation,renderMode,lineBreakMode:'PARAGRAPH' as const}};
  const stage=mode+'-'+name;setCurrent({stage,preset,text,blocks:[{type:'text',style:'body',text}]});await sleep(2500);
  const deadline=Date.now()+45000;while(systemTextResourceCounts().active||systemTextResourceCounts().queued){if(Date.now()>deadline)throw Error("Text queue did not settle");await sleep(100);}await sleep(500);
  kv.set('reader-paragraph-result',{state:'running',stage,nativePreset:preset,text,logicalWidth:getDisplayMetrics().logicalWidth,resources:systemTextResourceCounts()});
  const until=Date.now()+90000;while(!(await fileChunks.stat('paragraph-advance-'+stage)).file){if(Date.now()>until)throw Error('Snapshot timeout '+stage);await sleep(100);}
 }
 setCurrent(null);await sleep(2500);const counts=systemTextResourceCounts();if(counts.active||counts.cached||counts.queued)throw Error('Leaked text resources '+JSON.stringify(counts));
 if(JSON.stringify(kv.get('watchrss.reader-presets'))!==before)throw Error('Rendering changed preset storage');kv.set('reader-paragraph-result',{state:'passed',stage:'done',resources:counts,presetStorageUnchanged:true});
}
function App(){const metrics=getDisplayMetrics();return <Show when={current()} keyed>{value=>value.stage.startsWith('preview-')?<ReaderPreviewScreen state={{sessionId:'paragraph-fixture',sequence:0,preset:value.preset,resourceTransferInProgress:false,updatedAt:0}} width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} ref={()=>{}}/>:<ReaderBody articleId="1" text={value.text} blocks={value.blocks} preset={value.preset} width={metrics.logicalWidth} height={metrics.logicalHeight} top={0} fontSize={14} lineHeight={18.9} active={true} autoStart={false} speed={1} progressStore={{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}}} onMedia={()=>{}} onControls={()=>{}} onError={error=>kv.set('reader-paragraph-result',{state:'failed',error})} ref={()=>{}}/>}</Show>;}
mount(App);void run().catch(error=>kv.set('reader-paragraph-result',{state:'failed',error:String(error)}));
