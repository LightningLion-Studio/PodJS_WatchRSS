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
  expect((await f.db.query('SELECT * FROM note_merge_conflicts')).length).toBeGreaterThan(0);
 }finally{f.sql.close();}}
 // superseded: [false,false]; r3 retains initial tombstone/live branch.
 expect(outcomes).toEqual([true,false]);
});

test('RVM2-13 recurring cycle tuple must still accept the latest display version',async()=>{
 const f=store();try{
  await f.repo.initialize();const seed=await f.repo.save({title:'T',markdown:'a'});
  const v=(markdown:string,baseMarkdown:string,updatedAt:number)=>({...seed,markdown,plainText:markdown,contentHash:hash(markdown),baseMarkdown,baseContentHash:hash(baseMarkdown),updatedAt,modifiedBy:'peer'});
  for(const r of [v('b','a',101),v('a','b',300),v('b','a',400),v('a','b',500)])await f.repo.applyRemote(r);
  // superseded: body 'a', updatedAt 500; r3 refuses clock-based cycle selection.
  expect((await f.repo.get('n'))!.markdown).toBe('b');expect((await f.repo.get('n'))!.updatedAt).toBe(400);
  const bodies=(await f.db.query('SELECT * FROM note_merge_conflicts')).flatMap(r=>[r.local_markdown,r.remote_markdown]);
  expect(bodies).toContain('a');expect(bodies).toContain('b');
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

test('r3 reopening an existing store normalizes alias rows and resolution markers without a download',async()=>{
 const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:'n',markdown:'b'});
  await f.repo.applyRemote({...a,markdown:'c',modifiedBy:'peer'});
  const fresh=newConflictId('n','a','b','c','peer'),old=hash(['n','a','b','c','peer'].join('\0'));
  await f.db.execute('INSERT INTO note_merge_conflicts SELECT ?,note_id,base_markdown,local_markdown,remote_markdown,remote_device_id,created_at FROM note_merge_conflicts WHERE conflict_id=?',[old,fresh]);
  await f.db.execute('CREATE TABLE syncv2_note_resolutions(note_id TEXT NOT NULL,conflict_id TEXT NOT NULL,resolved_at INTEGER NOT NULL,PRIMARY KEY(note_id,conflict_id))');
  await f.db.execute('INSERT INTO syncv2_note_resolutions VALUES(?,?,?)',['n',fresh,50]);
  for(let i=0;i<2;i++){
   await new MemoRepository(f.db,'watch').initialize();
   expect(await f.db.query('SELECT conflict_id FROM note_merge_conflicts')).toEqual([{conflict_id:old}]);
   expect(await f.db.query('SELECT conflict_id,resolved_at FROM syncv2_note_resolutions')).toEqual([{conflict_id:old,resolved_at:50}]);
  }
 }finally{f.sql.close();}
});

test.skipIf(!process.env.NOTES_PHONE_REPOSITORY_MATRIX)('r3 actual phone, watch and mini repository decisions agree in both directions',async()=>{
 const vectors=await Bun.file(process.env.NOTES_PHONE_REPOSITORY_MATRIX!).json();
 const mini=require(process.env.NOTES_MINI_ROOT+'/miniprogram/lib/notes');
 const decode=(r:any)=>({noteId:r.id,folderId:r.folder,title:r.title,markdown:r.markdown,plainText:r.markdown,contentHash:r.hash,baseContentHash:hash(r.base),baseMarkdown:r.base,pinned:r.pinned,createdAt:r.createdAt,updatedAt:r.updatedAt,modifiedBy:r.modifiedBy,deleted:r.deleted,deletedAt:r.deletedAt});
 for(const v of vectors){const f=store();try{
  await f.repo.initialize();await f.repo.applyRemote(decode(v.local));await f.repo.applyRemote(decode(v.remote));
  const n=(await f.repo.allIncludingDeleted())[0];
  expect({markdown:n.markdown,deleted:n.deleted,title:n.title,folder:n.folderId,pinned:n.pinned,conflict:(await f.db.query("SELECT name FROM sqlite_master WHERE name='note_merge_conflicts'")).length>0&&(await f.db.query('SELECT * FROM note_merge_conflicts')).length>0}).toEqual(v.expected);
  const s={notes:{[v.local.id]:structuredClone(v.local)},conflicts:{}};mini.applyRemote(s,structuredClone(v.remote),999,'phone');const m=s.notes[v.local.id];
  expect({markdown:m.markdown,deleted:m.deleted,title:m.title,folder:m.folder,pinned:m.pinned,conflict:Object.keys(s.conflicts).length>0}).toEqual(v.expected);
 }finally{f.sql.close();}}
 expect(vectors).toHaveLength(81);
});


test('r3 repeated deletion of resolved content keeps live note and marker without a copy',async()=>{
 const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
  const dead={...a,deleted:true,deletedAt:200,updatedAt:200,modifiedBy:'peer'};
  await f.repo.applyRemote(dead);
  const rows=await f.db.query('SELECT * FROM note_merge_conflicts'),id=rows[0].conflict_id;
  await f.db.execute('CREATE TABLE syncv2_note_resolutions(note_id TEXT NOT NULL,conflict_id TEXT NOT NULL,resolved_at INTEGER NOT NULL,PRIMARY KEY(note_id,conflict_id))');
  await f.db.execute('INSERT INTO syncv2_note_resolutions VALUES(?,?,?)',['n',id,250]);
  await f.repo.applyRemote({...dead,deletedAt:300,updatedAt:300});
  expect(await f.repo.allIncludingDeleted()).toEqual([a]);
  expect(await f.db.query('SELECT * FROM note_merge_conflicts')).toEqual(rows);
  expect(await f.db.query('SELECT resolved_at FROM syncv2_note_resolutions')).toEqual([{resolved_at:250}]);
  expect((await f.db.query('SELECT * FROM note_cloud_receipts')).length).toBe(2);
 }finally{f.sql.close();}
});
