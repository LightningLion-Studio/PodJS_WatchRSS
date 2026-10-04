import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';

const metrics=getDisplayMetrics();
const markdown='| 左侧唯一词 | 右侧唯一词 |\n| --- | --- |\n| 下方左侧词 | 下方右侧词 |';
const note:MemoNote={noteId:'table-anchor',folderId:null,title:'表格光标定位',markdown,plainText:markdown,contentHash:'',baseContentHash:'',baseMarkdown:'',pinned:false,createdAt:0,updatedAt:0,modifiedBy:'fixture',deleted:false,deletedAt:0};
const repository={get:async()=>note} as unknown as MemoRepository;
mount(()=> <View class="absolute inset-0 bg-black"><NoteDetailScreen repository={repository} noteId="table-anchor" width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}}/></View>);
