import {mount} from '@pocketjs/framework/solid';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {View} from '@pocketjs/framework/components';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';

const metrics=getDisplayMetrics();
const markdown=Array.from({length:45},(_,index)=>`第 ${index+1} 行：滚动正文，验证编辑按钮的显示状态。`).join('\n');
const note:MemoNote={noteId:'reader-edit-fixture',folderId:null,title:'备忘录阅读按钮验证',markdown,plainText:markdown,contentHash:'fixture',baseContentHash:'fixture',baseMarkdown:markdown,pinned:false,createdAt:1,updatedAt:Date.now(),modifiedBy:'fixture',deleted:false,deletedAt:0};
const repo={get:async()=>note,save:async()=>note} as unknown as MemoRepository;
mount(()=><View class="absolute inset-0 bg-black"><NoteDetailScreen repository={repo} noteId={note.noteId} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} onError={message=>console.error('Note reader fixture:',message)}/></View>);
