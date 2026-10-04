import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {kv} from '@podjs/framework/watch';
import {sqlite,delay} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
const repo=new MemoRepository(sqlite as SqlDatabase,'note-live-fixture'),key='note-live-result';
const [visible,setVisible]=createSignal(false),[revision,setRevision]=createSignal(0);
let error='';
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function run(){
 await repo.initialize();check((await repo.allIncludingDeleted()).length===0,'Fixture memo table must be empty');
 const handler=createApplicationActionHandler({notes:repo,deviceId:async()=>'note-live-fixture',notesChanged:()=>setRevision(v=>v+1)});
 const row=(title:string,updatedAt:number,deleted=false)=>({noteId:'note-live-owned',title,markdown:'正文随手机同步更新',contentHash:String(updatedAt),baseContentHash:String(updatedAt),updatedAt,deleted});
 try{
  check((await handler({action:'syncNotes',notes:[row('同步前标题',1)]})).success,'Seed');setVisible(true);await delay(800).result;kv.set(key,{state:'running',phase:'before'});
  await delay(15000).result;check((await handler({action:'syncNotes',notes:[row('同步后标题',2)]})).success,'Update');await delay(800).result;kv.set(key,{state:'running',phase:'updated'});
  await delay(15000).result;check((await handler({action:'syncNotes',notes:[row('同步后标题',3,true)]})).success,'Delete');await delay(800).result;kv.set(key,{state:'running',phase:'deleted'});
  await delay(15000).result;check(!error,error);check(revision()===3,'Notifications');setVisible(false);
 }finally{await sqlite.execute('DELETE FROM memo_notes WHERE note_id=?',['note-live-owned']);}
 check((await repo.allIncludingDeleted()).length===0,'Cleanup');kv.set(key,{state:'passed',refreshEvents:revision(),ownedRowsRemoved:true,limitation:'Visual screenshots must be inspected; no physical input was synthesized.'});
}
mount(()=><Show when={visible()} fallback={<Text>Note live update verification</Text>}><NoteDetailScreen repository={repo} noteId="note-live-owned" refreshKey={revision()} width={466} height={466} input={async()=>null} onBack={()=>{error='Unexpected back';}} onError={message=>{error=message;}}/></Show>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
