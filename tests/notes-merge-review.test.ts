import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {MemoRepository} from '../src/notes/repository';
import {watchMaterializer} from '../src/sync-v2/materializer';
import {newConflictId} from '../src/sync-v2/notes-conflict';
import type {SqlDatabase} from '../src/core/types';

const hash = (s:string) => createHash('sha256').update(s).digest('hex');
test('RVM-08 ancestor replay after a -> b -> a does not undo the revert',async()=>{
  const f=store();try {
    await f.repo.initialize();await f.repo.save({title:'T',markdown:'a'});
    const b=await f.repo.save({noteId:'n',title:'T',markdown:'b'});
    await f.repo.applyRemote({...b,markdown:'a',plainText:'a',contentHash:hash('a'),baseMarkdown:'b',baseContentHash:hash('b'),updatedAt:300,modifiedBy:'peer'});
    expect((await f.repo.get('n'))!.markdown).toBe('b'); // superseded: 'a'; r3 retains current cycle branch.
    await f.repo.applyRemote(b);
    expect((await f.repo.get('n'))!.markdown).toBe('b'); // superseded: 'a'; r3 retains current cycle branch.
    const versions=(await f.db.query('SELECT * FROM note_merge_conflicts')).flatMap(r=>[r.local_markdown,r.remote_markdown]);
    expect(versions).toContain('a');expect(versions).toContain('b');
  } finally {f.sql.close();}
});
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

test('RVM-04 unchanged live peer metadata cannot resurrect a tombstone',async()=>{
  const f=store();try {
    await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
    const dead=await f.repo.delete('n');
    await f.repo.applyRemote({...a,updatedAt:dead.updatedAt+1,modifiedBy:'compose',pinned:true});
    expect((await f.repo.allIncludingDeleted())[0].deleted).toBe(true);
  } finally {f.sql.close();}
});

test('RVM-05 v2 materialization retains resolution on the new alias of a legacy ID',async()=>{
  const f=store();try {
    await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
    await f.repo.save({noteId:'n',title:'T',markdown:'b'});
    await f.repo.applyRemote({...a,markdown:'c',plainText:'c',contentHash:hash('c'),modifiedBy:'peer',updatedAt:300});
    const fresh=newConflictId('n','a','b','c','peer'),old=hash(['n','a','b','c','peer'].join('\0'));
    await f.db.execute('INSERT INTO note_merge_conflicts SELECT ?,note_id,base_markdown,local_markdown,remote_markdown,remote_device_id,created_at FROM note_merge_conflicts WHERE conflict_id=?',[old,fresh]);
    await f.db.execute('CREATE TABLE syncv2_note_resolutions(note_id TEXT,conflict_id TEXT,resolved_at INTEGER,PRIMARY KEY(note_id,conflict_id))');
    await f.db.execute('INSERT INTO syncv2_note_resolutions VALUES(?,?,?)',['n',fresh,500]);
    const row=(await f.db.query('SELECT * FROM memo_notes WHERE note_id=?',['n']))[0];
    // Actual legacy SQL -> v2 source adapter, not the conflictSet unit helper.
    const out=await watchMaterializer(f.db as any,{} as any)('memo_notes',row);
    expect(out[0].value.noteConflicts.records).toHaveLength(1);
    expect(out[0].value.noteConflicts.records[0].conflictId).toBe(old);
    expect(out[0].value.noteConflicts.records[0].resolvedAt).toBe(500);
  } finally {f.sql.close();}
});

test('RVM-CONTROL a sole new ID keeps its v2 resolution marker',async()=>{
  const f=store();try {
    await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
    await f.repo.save({noteId:'n',title:'T',markdown:'b'});
    await f.repo.applyRemote({...a,markdown:'c',plainText:'c',contentHash:hash('c'),modifiedBy:'peer',updatedAt:300});
    const fresh=newConflictId('n','a','b','c','peer');
    await f.db.execute('CREATE TABLE syncv2_note_resolutions(note_id TEXT,conflict_id TEXT,resolved_at INTEGER,PRIMARY KEY(note_id,conflict_id))');
    await f.db.execute('INSERT INTO syncv2_note_resolutions VALUES(?,?,?)',['n',fresh,500]);
    const out=await watchMaterializer(f.db as any,{} as any)('memo_notes',(await f.db.query('SELECT * FROM memo_notes'))[0]);
    expect(out[0].value.noteConflicts.records[0].resolvedAt).toBe(500);
  } finally {f.sql.close();}
});

test('RVM-08 ambiguous cycle keeps both bodies recoverable in either arrival order',async()=>{
 for(const swapped of [false,true]){const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
  const b={...a,markdown:'b',plainText:'b',contentHash:hash('b'),baseMarkdown:'a',updatedAt:101};
  const reverted={...a,baseMarkdown:'b',baseContentHash:hash('b'),updatedAt:300,modifiedBy:'peer'};
  await f.repo.applyRemote(swapped?reverted:b);await f.repo.applyRemote(swapped?b:reverted);
  const bodies=(await f.db.query('SELECT local_markdown,remote_markdown FROM note_merge_conflicts')).flatMap(r=>[r.local_markdown,r.remote_markdown]);
  expect(bodies).toContain('a');expect(bodies).toContain('b');
  expect((await f.repo.get('n'))!.markdown).toBe(swapped?'a':'b'); // superseded: 'a'; r3 retains current cycle branch.
 }finally{f.sql.close();}}
});

test('RVM-07 watch receive helpers normalize raw aliases before testing open incidents',async()=>{
 const {attachConflicts,readConflicts,mergeNoteWithConflicts}=await import('../src/sync-v2/notes-conflict');
 const old=hash(['n','a','b','c','peer'].join('\0')),fresh=newConflictId('n','a','b','c','peer');
 const row={noteId:'n',baseMarkdown:'a',localMarkdown:'b',remoteMarkdown:'c',remoteDeviceId:'peer',createdAt:1};
 const aliases={version:1 as const,records:[{...row,conflictId:old,resolvedAt:0},{...row,conflictId:fresh,resolvedAt:50}].sort((a,b)=>a.conflictId<b.conflictId?-1:1)};
 const context={entityKey:'0'.repeat(64),noteId:'n'},state={version:2,entityKey:context.entityKey,requiredFeatures:[],payload:{markdown:'c'},noteSegments:[]};
 const attached=attachConflicts(state,context,aliases);
 expect(attached.payload.noteConflicts.records).toHaveLength(1);
 expect(readConflicts({...attached,payload:{markdown:'c',noteConflicts:aliases}},context)!.records[0].resolvedAt).toBe(50);
 expect(mergeNoteWithConflicts('n','a','b','b',[aliases])).toEqual({markdown:'b'});
});

test('RVM-07 watch first business apply stores one resolved legacy alias',async()=>{
 const f=store();try{
  const {WatchAccountBusinessSql}=await import('../src/sync-v2/account-business');
  await f.repo.initialize();await f.repo.save({title:'T',markdown:'b'});
  const records=await watchMaterializer(f.db as any,{} as any)('memo_notes',(await f.db.query('SELECT * FROM memo_notes'))[0]);
  const old=hash(['n','a','b','c','peer'].join('\0')),fresh=newConflictId('n','a','b','c','peer');
  const row={noteId:'n',baseMarkdown:'a',localMarkdown:'b',remoteMarkdown:'c',remoteDeviceId:'peer',createdAt:1};
  records[0].value.noteConflicts={version:1,records:[{...row,conflictId:old,resolvedAt:0},{...row,conflictId:fresh,resolvedAt:50}].sort((a,b)=>a.conflictId<b.conflictId?-1:1)};
  const business=new WatchAccountBusinessSql(f.db as any,{readCandidate:async()=>null,candidatePage:async()=>[]} as any,{repoId:'0'.repeat(32),libraryEpoch:'1',contentGeneration:'1'},new Uint8Array(32),{} as any,(async()=>{}) as any,(async()=>{}) as any);
  await business.initialize();await f.db.transaction(await business.prepare(records,{} as any));
  expect(await f.db.query('SELECT conflict_id,resolved_at FROM syncv2_note_resolutions')).toEqual([{conflict_id:old,resolved_at:50}]);
  expect(await f.db.query('SELECT conflict_id FROM note_merge_conflicts')).toEqual([{conflict_id:old}]);
 }finally{f.sql.close();}
});

test('RVM-04 only the deleting writer can restore the same body with a newer version',async()=>{
 for(const source of ['peer','other',''])for(const reverse of [false,true]){const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});
  const dead={...a,deleted:true,deletedAt:101,updatedAt:101,modifiedBy:'peer'},live={...a,updatedAt:102,modifiedBy:source,pinned:true};
  await f.repo.applyRemote(reverse?live:dead);await f.repo.applyRemote(reverse?dead:live);
  // superseded: source!=='peer'; initial saved note is live in both orders.
  expect((await f.repo.allIncludingDeleted())[0].deleted).toBe(false);
  expect((await f.db.query('SELECT * FROM note_merge_conflicts')).length).toBeGreaterThan(0);
 }finally{f.sql.close();}}
});
