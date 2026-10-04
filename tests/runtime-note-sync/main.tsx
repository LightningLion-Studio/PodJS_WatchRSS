import nativeText from '../fixtures/note-text-native.json';
import {memoPlainText,memoTitle} from '../../src/notes/text.ts';
import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {MemoRepository} from '../../src/notes/index.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
const key='note-sync-result';
function check(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
async function run(){
 for(const c of nativeText.cases){check(memoPlainText(c.input)===c.plainText,'Native plain text: '+JSON.stringify(c.input));check(memoTitle(c.input)===c.title,'Native note title');}
 const repo=new MemoRepository(sqlite as SqlDatabase,'note-sync-fixture');await repo.initialize();
 check((await repo.allIncludingDeleted()).length===0,'Fixture memo table must be empty');
 const articles=await sqlite.query('SELECT count(*) n FROM articles'),started=Date.now();let events=0;
 const handle=createApplicationActionHandler({notes:repo,deviceId:async()=>'note-sync-fixture',notesChanged:()=>events++});
 const r=(extra:Record<string,unknown>={})=>({noteId:'note-sync-owned',markdown:'# 手机\n正文😀',contentHash:'base',baseContentHash:'base',updatedAt:100,...extra});
 try{
  check((await handle({action:'syncNotes',notes:[r()]})).applied===1,'Initial import');
  check((await handle({action:'syncNotes',notes:[r({updatedAt:1,contentHash:'dirty',markdown:'earlier clean overwrite'})]})).applied===1,'Clean baseline overwrite');
  check((await handle({action:'syncNotes',notes:[r({updatedAt:0})]})).applied===0,'Dirty version protection');
  check((await repo.get('note-sync-owned'))?.markdown==='earlier clean overwrite','Stored body');
  check((await handle({action:'syncNotes',notes:[r({updatedAt:1,deleted:true,deletedAt:1})]})).applied===1,'Equal-time tombstone');
  const response=await handle({action:'syncNotes'});check((response.notes as any[])[0]?.deleted===true,'Tombstone exported');check((await repo.list()).length===0,'Tombstone hidden');
  check(!(await handle({action:'syncNotes',notes:[r({noteId:'note-sync-never-written'}),null]})).success,'Malformed batch rejected');
  check((await repo.allIncludingDeleted()).length===1,'Malformed batch did not partially write');
  check(events===5,'Mutation notifications');
 }finally{await sqlite.execute('DELETE FROM memo_notes WHERE note_id=?',['note-sync-owned']);}
 check((await repo.allIncludingDeleted()).length===0,'Owned test rows removed');check(JSON.stringify(await sqlite.query('SELECT count(*) n FROM articles'))===JSON.stringify(articles),'Articles unchanged');
 kv.set(key,{state:'passed',nativeTextCases:nativeText.cases.length,productionActionHandler:true,sqliteMerge:true,cleanOlderOverwrite:true,dirtyOlderRejected:true,equalTimestampTombstone:true,malformedBatchNoPartialWrite:true,tombstoneExport:true,events,ownedRowsRemoved:true,articleCountUnchanged:true,elapsedMs:Date.now()-started});
}
mount(()=><Text>Note synchronization verification</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
