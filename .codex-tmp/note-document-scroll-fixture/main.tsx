import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import {createSignal,Show,onMount} from 'solid-js';
import {NoteInlineEditor} from '../../src/ui/NoteInlineEditor.tsx';
import {MemoRepository,initializeMemoSchema} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';
import type {SqlDatabase} from '../../src/core/types.ts';

const metrics=getDisplayMetrics();
const db:SqlDatabase={
 query:(sql,params)=>sqlite.query(sql,params as (string|number|null)[]),
 execute:(sql,params)=>sqlite.execute(sql,params as (string|number|null)[]),
 transaction:statements=>sqlite.transaction(statements as {sql:string;params?:(string|number|null)[]}[]),
 transactionChanges:statements=>sqlite.transactionChanges(statements as {sql:string;params?:(string|number|null)[]}[])
};
const markdown=Array.from({length:120},(_,n)=>`第${String(n).padStart(3,'0')}行 一二三四五六七八九十 ABCDEFGHIJ`).join('\n');
mount(()=>{
 const [note,setNote]=createSignal<MemoNote|null>(null),[error,setError]=createSignal('');
 const repository=new MemoRepository(db,'document-fixture');
 onMount(()=>{void initializeMemoSchema(db).then(()=>repository.save({title:'文档滚动测试',markdown})).then(setNote).catch(error=>setError(String(error)));});
 return <View class="absolute inset-0 bg-black"><Show when={note()}>{current=><NoteInlineEditor width={metrics.logicalWidth} height={metrics.logicalHeight} repository={repository} initial={current()} initialSelection={markdown.indexOf('第080行')} fallbackInput={async()=>null} onSaved={()=>{}} onClose={()=>{}} onError={setError}/>}</Show><Text class="absolute left-[4] bottom-[0] text-[9px] text-red-500">{error()}</Text></View>;
});
