import {mount} from '@pocketjs/framework/solid';
import {Show,createSignal} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {sqlite,delay} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {NoteDetailScreen,type NoteDetailHandle} from '../../src/ui/NotesScreen.tsx';

const id='note-image-failure-fixture';
const repository=new MemoRepository(sqlite as SqlDatabase,id,()=>id);
const metrics=getDisplayMetrics();
const [ready,setReady]=createSignal(false);
const preset=defaultReaderPreset('note-image-failure','Light',false,20);
let detail:NoteDetailHandle|undefined;
async function run(){
 await repository.initialize();
 await repository.save({title:'缺失图片',markdown:'![示例](assets/missing-image.png)'});
 setReady(true);
 await delay(1200).result;
 detail?.scroller?.scrollTo(90,{immediate:true});
 kv.set('note-image-failure',{state:'ready'});
}
mount(()=><Show when={ready()}><NoteDetailScreen repository={repository} noteId={id} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} onError={message=>kv.set('note-image-failure-error',message)} preset={preset} backgroundSnapshot={{state:{},revision:0}} active ref={value=>{detail=value;}}/></Show>);
void run().catch(error=>kv.set('note-image-failure-error',String(error)));
