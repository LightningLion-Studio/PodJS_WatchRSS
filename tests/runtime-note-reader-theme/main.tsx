import {mount} from '@pocketjs/framework/solid';
import {Show,createSignal} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';

const id='note-theme-fixture',repository=new MemoRepository(sqlite as SqlDatabase,id,()=>id);
const metrics=getDisplayMetrics(),[ready,setReady]=createSignal(false);
const preset=defaultReaderPreset('note-light','Light',false,20);
async function run(){
  await repository.initialize();
  await repository.save({title:'浅色备忘录',markdown:'正文应该使用深色文字。\n> 引用也需要可读。\n```\n代码\n```'});
  setReady(true);
  kv.set('note-theme-fixture',{ready:true,fontSizeSp:preset.body.fontSizeSp});
}
mount(()=><Show when={ready()}><NoteDetailScreen repository={repository} noteId={id} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} onError={message=>kv.set('note-theme-error',message)} preset={preset} backgroundSnapshot={{state:{},revision:0}} active/></Show>);
void run().catch(error=>kv.set('note-theme-error',String(error)));
