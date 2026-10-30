import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {novelBookSource,isNovelChapter,readNovelDirectory,novelResumeChapter,novelNavigation,novelPageDirection,novelMenuAppearance,openNovelChapterAfterSave,type NovelChapter} from '../../src/reader/novel.ts';
const source='https://watchrss.local/import-txt-novel/book';
const chapter=(n:number,clock=0):NovelChapter=>({id:String(n),title:'Chapter '+n,link:source+'/chapter/'+n+'-title',content:'',readingPositionChangedAt:clock});
test('directory reads metadata, orders numeric chapters and isolates books; resume follows the latest position clock',async()=>{
 const sqlite=new Database(':memory:');
 sqlite.exec('CREATE TABLE articles(id INTEGER,channel_id INTEGER,title TEXT,link TEXT,is_read INTEGER,content TEXT);CREATE TABLE article_reading_state(article_id INTEGER,changed_at INTEGER)');
 const insert=sqlite.prepare('INSERT INTO articles VALUES(?,1,?,?,0,?)');
 for(const n of [10,2,1])insert.run(n,'Chapter '+n,chapter(n).link!,'large body '.repeat(10000));
 insert.run(20,'Other book',source+'-other/chapter/1','other body');
 insert.run(21,'Not a chapter',source+'/chapter/not-a-number','no');
 sqlite.exec('INSERT INTO article_reading_state VALUES(2,900),(10,800)');
 try{
  const rows=await readNovelDirectory({query:async(sql,params)=>sqlite.query(sql).all(...params as any[]) as Record<string,unknown>[]},source,async()=>{});
  expect(rows.map(c=>c.id)).toEqual(['1','2','10']);expect(rows.every(c=>c.content==='')).toBe(true);
  expect(novelResumeChapter(rows)?.id).toBe('2');expect(novelResumeChapter(rows.map(c=>({...c,readingPositionChangedAt:0})))?.id).toBe('1');
  expect(novelNavigation(rows,'2')).toEqual({previous:rows[0],next:rows[2]});
  expect(novelNavigation(rows,'1')?.previous).toBeUndefined();expect(novelNavigation(rows,'10')?.next).toBeUndefined();expect(novelNavigation(rows,'missing')).toBeUndefined();
 }finally{sqlite.close();}
});
test('novel identity accepts EPUB and current numeric-only chapter URLs without treating ordinary imports or RSS as novels',()=>{
 expect(novelBookSource(source)).toBe(source);expect(isNovelChapter(source)).toBe(false);
 expect(novelBookSource(chapter(1).link)).toBe(source);expect(isNovelChapter(source+'/chapter/1')).toBe(true);
 expect(isNovelChapter('https://watchrss.local/import-epub/id/chapter/12-name')).toBe(true);
 for(const url of ['https://36kr.com/p/123','https://watchrss.local/import-content/txt/id',source+'/chapter/no',source+'/chapter/1/other'])expect(novelBookSource(url)).toBeUndefined();
});
test('page hit regions preserve the middle third and menu hides while moving, then reappears and dims on the source timings',()=>{
 expect([0,77,78,155,156,233].map(x=>novelPageDirection(x,233))).toEqual([-1,-1,0,0,1,1]);
 expect(novelPageDirection(-1,233)).toBe(0);expect(novelPageDirection(1,0)).toBe(0);
 expect(novelMenuAppearance(349,false).visible).toBe(false);expect(novelMenuAppearance(350,false)).toEqual({visible:true,opacity:1});
 expect(novelMenuAppearance(1849,false).opacity).toBe(1);expect(novelMenuAppearance(1850,false).opacity).toBe(.22);expect(novelMenuAppearance(9999,true).visible).toBe(false);
});
test('chapter change awaits progress, aborts navigation on failed save, and does not navigate after the route becomes inactive',async()=>{
 const calls:string[]=[];let complete!:()=>void;
 const reader={pause(){calls.push('pause');},scroller:{stop(){calls.push('stop');}},flushProgress(){calls.push('save');return new Promise<void>(resolve=>complete=resolve);}};
 const task=openNovelChapterAfterSave(reader,chapter(2),async c=>{calls.push('open '+c.id);},()=>true);
 expect(calls).toEqual(['pause','stop','save']);complete();await task;expect(calls.at(-1)).toBe('open 2');
 calls.length=0;await expect(openNovelChapterAfterSave({...reader,flushProgress:async()=>{throw Error('write failed');}},chapter(2),async()=>{calls.push('open');},()=>true)).rejects.toThrow('write failed');expect(calls).not.toContain('open');
 calls.length=0;const inactive=openNovelChapterAfterSave(reader,chapter(2),async()=>{calls.push('open');},()=>false);complete();await inactive;expect(calls).not.toContain('open');
});
