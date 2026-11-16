import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {MemoRepository} from '../src/notes/repository';
import {watchMaterializer} from '../src/sync-v2/materializer';
import {newConflictId} from '../src/sync-v2/notes-conflict';
import type {SqlDatabase} from '../src/core/types';

const hash = (s:string) => createHash('sha256').update(s).digest('hex');
function store() {
  const sql = new Database(':memory:');
  const db:SqlDatabase = {
    query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,
    execute:async(q,p=[])=>{sql.query(q).run(...p as any[])},
    transaction:async ss=>sql.transaction(()=>ss.forEach(s=>sql.query(s.sql).run(...(s.params??[]) as any[])))()
  };
  let now = 100;
  return {sql,db,repo:new MemoRepository(db,'watch',()=> 'n',()=>now++)};
}


test('RVM2-11 restored note survives a third writer and replayed old tombstone',async()=>{
 const outcomes:boolean[]=[];
 for(const reverse of [false,true]){const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
  const dead={...a,deleted:true,deletedAt:101,updatedAt:101,modifiedBy:'peer'};
  const restored={...a,updatedAt:102,modifiedBy:'peer'};
  const metadata={...a,updatedAt:103,modifiedBy:'third',pinned:true};
  await f.db.execute('DELETE FROM memo_notes');
  for(const r of reverse?[restored,metadata,dead]:[dead,restored,metadata])await f.repo.applyRemote(r);
  outcomes.push((await f.repo.allIncludingDeleted())[0].deleted);
 }finally{f.sql.close();}}
 expect(outcomes).toEqual([false,false]);
});

test('RVM2-13 recurring cycle tuple must still accept the latest display version',async()=>{
 const f=store();try{
  await f.repo.initialize();const seed=await f.repo.save({title:'T',markdown:'a'});
  const v=(markdown:string,baseMarkdown:string,updatedAt:number)=>({...seed,markdown,plainText:markdown,contentHash:hash(markdown),baseMarkdown,baseContentHash:hash(baseMarkdown),updatedAt,modifiedBy:'peer'});
  for(const r of [v('b','a',101),v('a','b',300),v('b','a',400),v('a','b',500)])await f.repo.applyRemote(r);
  expect((await f.repo.get('n'))!.markdown).toBe('a');
  expect((await f.repo.get('n'))!.updatedAt).toBe(500);
 }finally{f.sql.close();}
});

test('RVM2-CONTROL watch and mini v2 normalize Unicode aliases identically over six rounds',async()=>{
 const n=await import('../src/sync-v2/notes-conflict');
 const mini=require(process.env.NOTES_MINI_V2_ROOT+'/miniprogram/lib/sync-v2/notes-conflict');
 const context={entityKey:'0'.repeat(64),noteId:'n'};
 for(const body of ['a','\0','😀','é','\u202e1:2'])for(const resolvedOld of [false,true]){
  const tuple=['n',body,'local:'+body,'remote:'+body,'peer'];
  const old=hash(tuple.join('\0')),fresh=n.newConflictId(...tuple as [string,string,string,string,string]);
  expect(fresh).toBe(mini.newConflictId(...tuple));
  const row={noteId:'n',baseMarkdown:tuple[1],localMarkdown:tuple[2],remoteMarkdown:tuple[3],remoteDeviceId:'peer'};
  let raw:any={version:1,records:[{...row,conflictId:old,createdAt:9,resolvedAt:resolvedOld?50:0},{...row,conflictId:fresh,createdAt:3,resolvedAt:resolvedOld?0:50}].sort((a,b)=>a.conflictId<b.conflictId?-1:1)};
  for(let round=0;round<6;round++){
   const state={version:2,entityKey:context.entityKey,requiredFeatures:['note-conflicts.v1'],payload:{markdown:'body',noteConflicts:raw},noteSegments:[]};
   const watch=n.readConflicts(state,context),miniOut=mini.readConflicts(state,context);
   expect(watch).toEqual(miniOut);expect(watch!.records).toHaveLength(1);
   expect(watch!.records[0].conflictId).toBe(old);expect(watch!.records[0].resolvedAt).toBe(50);raw=miniOut;
  }
 }
});
