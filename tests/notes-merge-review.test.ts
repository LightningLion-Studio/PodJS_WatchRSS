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
    expect((await f.repo.get('n'))!.markdown).toBe('a');
    await f.repo.applyRemote(b);
    expect((await f.repo.get('n'))!.markdown).toBe('a');
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
