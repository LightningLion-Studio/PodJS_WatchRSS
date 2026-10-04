import {mount} from '@pocketjs/framework/solid';
import {Text, View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {createSignal} from 'solid-js';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import type {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';

const metrics=getDisplayMetrics();
const markdown=Array.from({length:90},(_,n)=>`第${String(n+1).padStart(2,'0')}行固定内容 ABCDEF`).join('\n');
const note:MemoNote={noteId:'return',folderId:null,title:'阅读位置往返测试',markdown,plainText:markdown,contentHash:'',baseContentHash:'',baseMarkdown:'',pinned:false,createdAt:0,updatedAt:0,modifiedBy:'fixture',deleted:false,deletedAt:0};
const repository={get:async()=>note} as unknown as MemoRepository;

mount(()=>{
  type Scroller={offset:()=>number;scrollTo:(offset:number,options:{immediate:true})=>void};
  let reader:Scroller|undefined,frame=0,baseline=-1,visitedEditor=false,returned=false;
  const [result,setResult]=createSignal('waiting');
  onFrame(()=>{
    frame++;
    if(frame===40)reader?.scrollTo(600,{immediate:true});
    if(frame===55)reader?.scrollTo(598,{immediate:true});
    if(frame===80&&reader){baseline=reader.offset();setResult(`before=${baseline.toFixed(1)}`);}
    if(visitedEditor&&reader&&!returned){returned=true;setResult(`before=${baseline.toFixed(1)} after=${reader.offset().toFixed(1)}`);}
  });
  return <View class="absolute inset-0 bg-black">
    <NoteDetailScreen repository={repository} noteId="return" width={metrics.logicalWidth} height={metrics.logicalHeight} input={async()=>null} onBack={()=>{}} ref={value=>{reader=value.scroller as Scroller|undefined;if(!reader)visitedEditor=true;}}/>
    <Text class="absolute top-[0] left-[0] text-[8px] text-white" accessibilityLabel={`return-scroll ${result()}`}>{result()}</Text>
  </View>;
});
