import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import {createSignal,Show,onMount} from 'solid-js';
import {NoteInlineEditor} from '../../src/ui/NoteInlineEditor.tsx';
import {MemoRepository,initializeMemoSchema} from '../../src/notes/repository.ts';
import type {SqlDatabase} from '../../src/core/types.ts';

const metrics=getDisplayMetrics();
const db:SqlDatabase={
 query:(sql,params)=>sqlite.query(sql,params as (string|number|null)[]),
 execute:(sql,params)=>sqlite.execute(sql,params as (string|number|null)[]),
 transaction:statements=>sqlite.transaction(statements as {sql:string;params?:(string|number|null)[]}[]),
 transactionChanges:statements=>sqlite.transactionChanges(statements as {sql:string;params?:(string|number|null)[]}[])
};
mount(()=>{
 const [ready,setReady]=createSignal(false),[error,setError]=createSignal('');
 const repository=new MemoRepository(db,'fixture');
 onMount(()=>{void initializeMemoSchema(db).then(()=>setReady(true)).catch(error=>setError(String(error)));});
 return <View class="absolute inset-0 bg-black"><Show when={ready()}><NoteInlineEditor width={metrics.logicalWidth} height={metrics.logicalHeight} repository={repository} initial={null} fallbackInput={async()=>null} onSaved={()=>{}} onClose={()=>{}} onError={setError}/></Show><Text class="absolute left-[4] bottom-[0] text-[9px] text-red-500">{error()}</Text></View>;
});
