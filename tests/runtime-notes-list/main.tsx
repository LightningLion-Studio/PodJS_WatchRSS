import {mount} from '@pocketjs/framework/solid';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal} from 'solid-js';
import {NotesListScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoNote} from '../../src/notes/types.ts';
import type {MemoRepository} from '../../src/notes/repository.ts';

const metrics=getDisplayMetrics();
const notes=['alpha','bravo','charlie'].map((id,index)=>({noteId:id,folderId:null,title:`隔离备忘录 ${index+1}`,markdown:`第 ${index+1} 条内容`,plainText:`第 ${index+1} 条内容`,contentHash:id,baseContentHash:id,baseMarkdown:'',pinned:false,createdAt:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0})) as MemoNote[];
const repository={list:async()=>notes} as MemoRepository;
mount(()=>{
 const [event,setEvent]=createSignal('READY');
 return <View class="absolute inset-0 bg-black"><NotesListScreen width={metrics.logicalWidth} height={metrics.logicalHeight} repository={repository} onOpenNote={id=>setEvent(`OPEN:${id}`)} onOpenActions={id=>setEvent(`ACTIONS:${id}`)} onCreateNote={()=>setEvent('CREATE')} onError={message=>setEvent(`ERROR:${message}`)}/><View class="absolute left-[2] right-[2] bottom-[2] rounded-[4] bg-[#17191a]"><Text class="text-[10px] leading-[12px] text-[#55ff88]">{event()}</Text></View></View>;
});
