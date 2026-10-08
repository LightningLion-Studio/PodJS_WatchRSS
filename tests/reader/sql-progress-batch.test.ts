import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initializeSchema} from '../../src/core/schema.ts';
import {ReadingProgressStore} from '../../src/reader/progress.ts';
import {SqlReadingProgressStore} from '../../src/reader/sql-progress.ts';
import type {SqlDatabase} from '../../src/core/types.ts';

test('bulk migration preserves legacy anchors, existing SQL clocks and default progress in one transaction',async()=>{
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');let transactions=0;
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{transactions++;sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[])})();}};
 try{
  await initializeSchema(db);await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://example.test','Feed',1)");
  for(let id=1;id<=3;id++)await db.execute('INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at,reading_progress) VALUES(?,?,?,?,?,?)',[id,1,`Article ${id}`,`key-${id}`,id,id===3?.2:0]);
  await db.execute("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(2,.7,200,4,'remote')");
  const legacy=new Map<string,string>([['watchrss.reader.progress.1',JSON.stringify({offset:42,progress:.4,updatedAt:100,textAnchor:{character:5,fraction:.3}})]]);
  const progress=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async key=>legacy.get(key)??null,set:async(key,value)=>{legacy.set(key,value);}}));
  transactions=0;
  await progress.migrateMany([1,2,3,3]);
  expect(transactions).toBe(1);
  expect(await progress.load(1)).toMatchObject({offset:42,progress:Math.fround(.4),updatedAt:100,textAnchor:{character:5,fraction:.3}});
  expect(await progress.load(2)).toMatchObject({progress:.7,updatedAt:200});
  expect(await progress.load(3)).toMatchObject({progress:.2,updatedAt:0});
  expect((await db.query('SELECT id,reading_progress FROM articles ORDER BY id')).map(r=>Number(r.reading_progress))).toEqual([Math.fround(.4),0,.2]);
  await progress.migrateMany([1,2,3]);expect(transactions).toBe(1);
 }finally{sql.close();}
});

test('cold recovery retains the lifecycle snapshot while a pre-background SQL sample completes later',async()=>{
 const {LifecycleReadingProgressStore}=await import('../../src/reader/lifecycle-progress.ts');
 const {ReadingProgressWriteQueue}=await import('../../src/reader/progress-write-queue.ts');
 const sql=new Database(':memory:');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[])})()};
 const values=new Map<string,any>(),storage={get:<T>(key:string)=>values.get(key) as T|undefined,set:(key:string,v:unknown)=>{values.set(key,structuredClone(v));},delete:(key:string)=>values.delete(key)};
 try {
  await initializeSchema(db);await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://example.test','Feed',1)");
  await db.execute("INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at) VALUES(7,1,'Article','k',1)");
  const sqlStore=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async()=>null,set:async()=>{}}));
  await sqlStore.load(7);
  const store=new LifecycleReadingProgressStore(sqlStore,storage),queue=new ReadingProgressWriteQueue();
  const sample={offset:40,progress:.04,updatedAt:100,textAnchor:{character:40,fraction:.1}};
  const old=queue.enqueue(store.prepareSave(7,sample));
  const latest={offset:419,progress:.419,updatedAt:101,textAnchor:{character:419,fraction:.25}};
  store.checkpoint(7,latest);await old;
  expect((await sqlStore.load(7)).updatedAt).toBe(100);
  const cold=new LifecycleReadingProgressStore(new SqlReadingProgressStore(db,new ReadingProgressStore({get:async()=>null,set:async()=>{}})),storage);
  expect(await cold.load(7)).toEqual(latest);
  expect(await sqlStore.load(7)).toMatchObject({offset:419,progress:Math.fround(.419),updatedAt:101,textAnchor:latest.textAnchor});
  expect(values.size).toBe(0);
 }finally {sql.close();}
});
