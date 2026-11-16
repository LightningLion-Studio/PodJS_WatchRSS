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



test('CONTROL fork, tombstone and unknown ancestry never erase either body in either direction',async()=>{
 const cases=[
  {a:'old',ab:'base-a',b:'new',bb:'base-b',ad:false,bd:false,source:'peer'},
  {a:'a',ab:'b',b:'b',bb:'a',ad:false,bd:false,source:'peer'},
  {a:'live',ab:'live',b:'edit',bb:'live',ad:true,bd:false,source:'peer'},
  {a:'one',ab:'base',b:'two',bb:'base',ad:true,bd:true,source:'peer'},
  {a:'one',ab:'base',b:'two',bb:'one',ad:false,bd:false,source:''},
 ];
 for(const c of cases)for(const reverse of [false,true]){const f=store();try{
  await f.repo.initialize();const seed=await f.repo.save({title:'T',markdown:'seed'});await f.db.execute('DELETE FROM memo_notes');
  const n=(body:string,base:string,deleted:boolean,source:string,t:number)=>({...seed,markdown:body,plainText:body,contentHash:hash(body),baseMarkdown:base,baseContentHash:hash(base),deleted,deletedAt:deleted?t:0,modifiedBy:source,updatedAt:t});
  const rows=[n(c.a,c.ab,c.ad,'local',1000),n(c.b,c.bb,c.bd,c.source,1)];if(reverse)rows.reverse();
  for(const row of rows)await f.repo.applyRemote(row);
  expect((await f.repo.allIncludingDeleted())[0]).toEqual(rows[0]);
  const versions=(await f.db.query('SELECT * FROM note_merge_conflicts')).flatMap(r=>[r.local_markdown,r.remote_markdown]);
  expect(versions).toContain(c.a);expect(versions).toContain(c.b);
 }finally{f.sql.close();}}
});
test('CONTROL strict fast-forward ignores clock rollback and common base diff3 preserves two edits',async()=>{
 const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a\nb'});
  const version=(body:string,base:string,time:number)=>({...a,markdown:body,plainText:body,contentHash:hash(body),baseMarkdown:base,baseContentHash:hash(base),updatedAt:time,modifiedBy:'peer'});
  await f.repo.applyRemote(version('A\nb','a\nb',1));expect((await f.repo.get('n'))!.markdown).toBe('A\nb');
  await f.repo.applyRemote(version('a\nB','a\nb',2));expect((await f.repo.get('n'))!.markdown).toBe('A\nB');
 }finally{f.sql.close();}
});
test('CONTROL receipt history preserves explicit resolved body across an unrelated note',async()=>{
 const f=store();try{
  await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:'n',markdown:'b'});
  const r={...a,markdown:'c',plainText:'c',contentHash:hash('c'),baseMarkdown:'z',baseContentHash:hash('z'),modifiedBy:'peer',updatedAt:300};await f.repo.applyRemote(r);
  await f.repo.save({noteId:'n',markdown:'resolved'});const before=await f.repo.get('n');
  await f.repo.applyRemote({...a,noteId:'other'});await f.repo.applyRemote(r);
  expect(await f.repo.get('n')).toEqual(before);expect((await f.db.query('SELECT * FROM note_merge_conflicts')).length).toBe(1);
 }finally{f.sql.close();}
});
test('CONTROL U53 exhaustion rejects before changing note or receipt',async()=>{
 const f=store();try{
  await f.repo.initialize();const seed=await f.repo.save({title:'T',markdown:'a'});
  const a={...seed,updatedAt:Number.MAX_SAFE_INTEGER,modifiedBy:'z'};await f.repo.applyRemote(a);
  const r={...a,markdown:'b',plainText:'b',contentHash:hash('b'),modifiedBy:'a'};
  const before=await f.repo.get('n'),receipts=await f.db.query('SELECT * FROM note_cloud_receipts');
  await expect(f.repo.applyRemote(r)).rejects.toThrow('counter_exhausted');
  expect(await f.repo.get('n')).toEqual(before);expect(await f.db.query('SELECT * FROM note_cloud_receipts')).toEqual(receipts);
 }finally{f.sql.close();}
});
