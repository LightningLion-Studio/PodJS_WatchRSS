import {mount} from '@pocketjs/framework/solid';
import {createSignal,Show} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {NotesListScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';
const metrics=getDisplayMetrics();
const note=(id:string,title:string,plainText:string):MemoNote=>({noteId:id,folderId:null,title,markdown:plainText,plainText,contentHash:'',baseContentHash:'',baseMarkdown:'',pinned:false,createdAt:0,updatedAt:0,modifiedBy:'fixture',deleted:false,deletedAt:0});
const notes=[note('long','README','hymission [图片：4024] hymission 很长的备忘录摘要会跨越卡片边界，这里继续补足第二行。'),note('title','这是一条需要换行显示的很长备忘录标题','第二条笔记的摘要'),note('short','短','你好')];
const repository={list:async()=>notes} as unknown as MemoRepository;
mount(()=>{
 const [event,setEvent]=createSignal('');
 return <View class="absolute inset-0 bg-black"><NotesListScreen repository={repository} width={metrics.logicalWidth} height={metrics.logicalHeight} onOpenNote={id=>setEvent('OPEN:'+id)} onCreateNote={()=>setEvent('CREATE')} onOpenActions={id=>setEvent('ACTIONS:'+id)}/><Show when={event()}><Text class="absolute left-[5] top-[3] text-[12px] text-[#55ff88]">{event()}</Text></Show></View>;
});
