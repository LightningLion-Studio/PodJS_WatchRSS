import {mount} from '@pocketjs/framework/solid';
import {Show,createSignal} from 'solid-js';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {NoteDetailScreen,type NoteDetailHandle} from '../../src/ui/NotesScreen.tsx';

const id='note-long-reader-fixture',repository=new MemoRepository(sqlite as SqlDatabase,id,()=>id);
const metrics=getDisplayMetrics(),[ready,setReady]=createSignal(false);
const preset=defaultReaderPreset('note-light','Light',false,20);
const markdown=Array.from({length:120},(_,index)=>`第 ${index+1} 段。这是一段用于验证长备忘录阅读页排版和滚动的固定中文内容。`).join('\n\n');
let handle:NoteDetailHandle|undefined,readyAt=0,scrollRequested=false,finished=false;
async function run(){
 await repository.initialize();
 await repository.save({title:'长备忘录阅读验证',markdown});
 readyAt=Date.now();setReady(true);
 kv.set('note-long-reader',{state:'ready',paragraphs:120,characters:markdown.length});
}
mount(()=>{
 onFrame(()=>{
  if(!ready()||!handle?.scroller||finished)return;
  const elapsed=Date.now()-readyAt;
  if(elapsed>5000&&!scrollRequested){scrollRequested=true;handle.scroller.scrollTo(1600,{immediate:true});}
  if(elapsed>7000&&scrollRequested){finished=true;kv.set('note-long-reader',{state:'scrolled',paragraphs:120,characters:markdown.length,offset:handle.scroller.offset(),elapsedMs:elapsed});}
 });
 return <Show when={ready()}><NoteDetailScreen repository={repository} noteId={id} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} onError={message=>kv.set('note-long-reader-error',message)} preset={preset} backgroundSnapshot={{state:{},revision:0}} active ref={value=>handle=value}/></Show>;
});
void run().catch(error=>kv.set('note-long-reader-error',String(error)));
