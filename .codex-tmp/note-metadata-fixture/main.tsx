import {mount} from '@pocketjs/framework/solid';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';
const metrics=getDisplayMetrics();
const note:MemoNote={noteId:'fixture-note',folderId:null,title:'时间元信息',markdown:'你好世界',plainText:'你好 世界😀',contentHash:'',baseContentHash:'',baseMarkdown:'',pinned:false,createdAt:1786958977000,updatedAt:1786958977000,modifiedBy:'fixture',deleted:false,deletedAt:0};
const repository={get:async()=>note} as unknown as MemoRepository;
mount(()=><NoteDetailScreen repository={repository} noteId={note.noteId} width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}}/>);
