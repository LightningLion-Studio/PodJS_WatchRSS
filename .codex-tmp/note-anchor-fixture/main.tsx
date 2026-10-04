import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';

const metrics=getDisplayMetrics();
const markdown=Array.from({length:24},(_,n)=>`第${String(n+1).padStart(2,'0')}行固定内容 ABCDEF`).join('\n');
const note:MemoNote={noteId:'anchor',folderId:null,title:'光标定位测试',markdown,plainText:markdown,contentHash:'',baseContentHash:'',baseMarkdown:'',pinned:false,createdAt:0,updatedAt:0,modifiedBy:'fixture',deleted:false,deletedAt:0};
const repository={get:async()=>note} as unknown as MemoRepository;
mount(()=> {
 let handle: {scroller?: {scrollTo:(offset:number,options:{immediate:boolean})=>void;scrollBy:(delta:number,options:{immediate:boolean})=>void}}|undefined;
 let frames=0;
 onFrame(()=>{if(!handle?.scroller)return;frames++;if(frames===40)handle.scroller.scrollTo(160,{immediate:true});if(frames===55)handle.scroller.scrollBy(-2,{immediate:true});});
 return <View class="absolute inset-0 bg-black"><NoteDetailScreen repository={repository} noteId="anchor" width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} ref={value=>{handle=value;}}/></View>;
});
