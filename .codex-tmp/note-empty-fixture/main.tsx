import { mount } from '@pocketjs/framework/solid';
import { createSignal, Show } from 'solid-js';
import { Text, View } from '@pocketjs/framework/components';
import { getDisplayMetrics } from '@podjs/framework/watch';
import { NotesListScreen } from '../../src/ui/NotesScreen.tsx';
import type { MemoRepository } from '../../src/notes/repository.ts';

const metrics=getDisplayMetrics();
const repository={list:async()=>[]} as unknown as MemoRepository;
mount(()=>{
 const [created,setCreated]=createSignal(false);
 return <View class="absolute inset-0 bg-black">
  <NotesListScreen repository={repository} width={metrics.logicalWidth} height={metrics.logicalHeight} onOpenNote={()=>{}} onCreateNote={()=>setCreated(true)} onOpenActions={()=>{}}/>
  <Show when={created()}><Text class="absolute left-[18] right-[18] top-[5] text-[12px] text-[#55ff88]">CREATE_TAPPED</Text></Show>
 </View>;
});
