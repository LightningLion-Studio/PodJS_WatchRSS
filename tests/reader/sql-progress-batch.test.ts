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
