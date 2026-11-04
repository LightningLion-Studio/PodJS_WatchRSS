import {expect,test} from 'bun:test';
import {bookFixture,seedChapters} from '../books/fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';

test('cloud full export batches private bodies and preserves every exported value',async()=>{
 const f=await bookFixture();
 try{
  const bodies=Array.from({length:65},(_,i)=>({title:'Article '+i,contentText:'body '+i+' '.repeat(300),contentHtml:null}));
  await seedChapters(f,'watchrss://phone-imports',bodies);
  const repo=new SqlLibrarySessionRepository(f.db,f.ports);
  await repo.cloudSnapshot(false);
  const local=(repo as any).local,materialize=local.materializeRequestedBatch.bind(local),pages:number[]=[];
  local.materializeRequestedBatch=async(items:any[])=>{pages.push(items.length);return materialize(items);};
  const result=await repo.cloudSnapshot(true);
  expect(pages).toEqual([32,32,1]);
  expect(result.articles.map(a=>a.contentText).sort()).toEqual(bodies.map(b=>b.contentText).sort());

 }finally{f.sql.close();}
},15000);

test('cloud full export observes cancellation between body batches',async()=>{
 const f=await bookFixture();
 try{
  await seedChapters(f,'watchrss://phone-imports',Array.from({length:40},(_,i)=>({title:'Article '+i,contentText:'body '+i,contentHtml:null})));
  const repo=new SqlLibrarySessionRepository(f.db,f.ports);await repo.cloudSnapshot(false);
  const local=(repo as any).local,materialize=local.materializeRequestedBatch.bind(local);let completed=0;
  local.materializeRequestedBatch=async(items:any[])=>{const result=await materialize(items);completed++;return result;};
  await expect(repo.cloudSnapshot(true,()=>{if(completed)throw Error('cloud_sync_suspended');})).rejects.toThrow('cloud_sync_suspended');
  expect(completed).toBe(1);expect((await f.db.query('SELECT COUNT(*) AS n FROM articles'))[0]!.n).toBe(40);
 }finally{f.sql.close();}
},15000);
