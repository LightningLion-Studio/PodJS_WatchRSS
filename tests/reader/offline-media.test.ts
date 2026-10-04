import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {offlineMediaPath,readOfflineMedia,retryOfflineMedia} from '../../src/reader/offline-media.ts';

test('offline media accepts only files owned by the article',()=>{
  expect(offlineMediaPath(42,'offline/rss/42/image_0.jpg')).toBe('offline/rss/42/image_0.jpg');
  for(const path of ['offline/rss/41/image.jpg','offline/rss/42/../image.jpg','offline/rss/42/a/b.jpg',
    'offline/rss/42/.hidden','offline/rss/42/image.part','/offline/rss/42/image.jpg'])
    expect(offlineMediaPath(42,path)).toBeNull();
});

test('retry stores a recovered path while leaving valid media untouched',async()=>{
  const sqlite=new Database(':memory:');
  try{
    sqlite.exec('CREATE TABLE offline_media(id INTEGER PRIMARY KEY,item_id INTEGER,origin_url TEXT,media_type TEXT,relative_path TEXT)');
    sqlite.prepare('INSERT INTO offline_media VALUES(?,?,?,?,?)').run(1,42,'https://a/ready.jpg','IMAGE','offline/rss/42/ready.jpg');
    sqlite.prepare('INSERT INTO offline_media VALUES(?,?,?,?,?)').run(2,42,'https://a/failed.png','IMAGE',null);
    const db={query:async(sql:string,params?:(string|number|null)[])=>sqlite.prepare(sql).all(...(params??[])) as Record<string,unknown>[],
      execute:async(sql:string,params?:(string|number|null)[])=>{sqlite.prepare(sql).run(...(params??[]));}};
    const files=new Set(['offline/rss/42/ready.jpg']),downloads:string[]=[],removed:string[]=[];
    const result=await retryOfflineMedia(db,{stat:async path=>({file:files.has(path),size:files.has(path)?123:0}),
      download:async(_url,path)=>{downloads.push(path);files.add(path);},remove:async path=>{removed.push(path);files.delete(path);}},42);
    expect(downloads).toEqual(['offline/rss/42/image_2.png']);
    expect(removed).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.available['https://a/failed.png']).toBe('offline/rss/42/image_2.png');
    expect(sqlite.prepare('SELECT relative_path FROM offline_media WHERE id=2').get()).toEqual({relative_path:'offline/rss/42/image_2.png'});
  }finally{sqlite.close();}
});

test('offline media exposes only present files and retains failure count',async()=>{
  const sqlite=new Database(':memory:');
  try{
    sqlite.exec('CREATE TABLE offline_media(id INTEGER PRIMARY KEY,item_id INTEGER,origin_url TEXT,media_type TEXT,relative_path TEXT)');
    sqlite.prepare('INSERT INTO offline_media VALUES(?,?,?,?,?)').run(1,42,'https://a/image.jpg','IMAGE','offline/rss/42/image_0.jpg');
    sqlite.prepare('INSERT INTO offline_media VALUES(?,?,?,?,?)').run(2,42,'https://a/missing.jpg','IMAGE',null);
    sqlite.prepare('INSERT INTO offline_media VALUES(?,?,?,?,?)').run(3,42,'https://a/stale.jpg','IMAGE','offline/rss/42/stale.jpg');
    const db={query:async(sql:string,params?:(string|number|null)[])=>sqlite.prepare(sql).all(...(params??[])) as Record<string,unknown>[]};
    const seen:string[]=[];
    const result=await readOfflineMedia(db,{stat:async path=>{seen.push(path);return {file:true,size:path.endsWith('stale.jpg')?0:12};}},42);
    expect(result).toEqual({available:{'https://a/image.jpg':'offline/rss/42/image_0.jpg'},failed:2});
    expect(seen).toEqual(['offline/rss/42/image_0.jpg','offline/rss/42/stale.jpg']);
  }finally{sqlite.close();}
});
