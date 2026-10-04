import {mount} from '@pocketjs/framework/solid';
import {Show,createSignal} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';

const id='note-table-code-fixture',repository=new MemoRepository(sqlite as SqlDatabase,id,()=>id);
const metrics=getDisplayMetrics(),[ready,setReady]=createSignal(false);
const preset=defaultReaderPreset('note-table-code','Light',false,20);
async function run(){
 await repository.initialize();
 await repository.save({title:'代码表格',markdown:'| 名称 | 示例 |\n| --- | --- |\n| **原文** | 前`码`后 |'});
 setReady(true);kv.set('note-table-code',{state:'ready'});
}
mount(()=><Show when={ready()}><NoteDetailScreen repository={repository} noteId={id} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} onError={message=>kv.set('note-table-code-error',message)} preset={preset} backgroundSnapshot={{state:{},revision:0}} active/></Show>);
void run().catch(error=>kv.set('note-table-code-error',String(error)));
