import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {readSavedLinks} from '../../src/sync/saved-links.ts';

test('legacy saved-link pull preserves each list order and omits blank links', async () => {
  const calls:string[]=[];
  const handle=createApplicationActionHandler({notes:{} as never,notesChanged:()=>{},deviceId:async()=> 'watch',
    readSavedLinks:async type=>{calls.push(type);return type==='favorite'
      ? [' https://example.com/a ','','  ','https://example.com/b']
      : ['https://example.com/later'];}});
  expect(await handle({action:'ping',nonce:'abc'})).toEqual({success:true,action:'pong',nonce:'abc'});
  expect(await handle({action:'pullSavedItems',type:' sync_favorites '})).toEqual({
    success:true,action:'pullSavedItems',type:'FAVORITE',count:2,
    items:[{link:'https://example.com/a'},{link:'https://example.com/b'}],
  });
  expect(await handle({action:'pullSavedItems',type:'watchlater'})).toEqual({
    success:true,action:'pullSavedItems',type:'WATCH_LATER',count:1,
    items:[{link:'https://example.com/later'}],
  });
  expect(calls).toEqual(['favorite','watchLater']);
});

test('unknown saved type is rejected before reading the database', async () => {
  let reads=0;
  const handle=createApplicationActionHandler({notes:{} as never,notesChanged:()=>{},deviceId:async()=> 'watch',
    readSavedLinks:async()=>{reads++;return [];}});
  expect(await handle({action:'pullSavedItems',type:'RECENT'})).toEqual({success:false,message:'未知保存类型：RECENT'});
  expect(reads).toBe(0);
});

test('saved-link export reads all rows in native saved order and excludes cancelled states', async () => {
  const sqlite=new Database(':memory:');
  try {
    sqlite.exec('CREATE TABLE articles(id INTEGER PRIMARY KEY,link TEXT); CREATE TABLE article_saved_states(article_id INTEGER,save_type TEXT,saved INTEGER,sort_order INTEGER,changed_at INTEGER); CREATE TABLE article_saved_entry_times(article_id INTEGER,save_type TEXT,created_at INTEGER)');
    sqlite.exec("INSERT INTO articles VALUES(1,'https://a'),(2,'https://b'),(3,'https://later'),(4,'https://cancelled'),(5,NULL)");
    sqlite.exec("INSERT INTO article_saved_states VALUES(1,'favorite',1,1,100),(2,'favorite',1,0,200),(3,'watchLater',1,0,300),(4,'favorite',0,0,400),(5,'favorite',1,2,500)");
    sqlite.exec("INSERT INTO article_saved_entry_times VALUES(1,'favorite',50),(2,'favorite',60),(3,'watchLater',70)");
    const db={query:async(sql:string,params?:(string|number|null)[])=>sqlite.prepare(sql).all(...(params??[])) as Record<string,unknown>[]};
    const handle=createApplicationActionHandler({notes:{} as never,notesChanged:()=>{},deviceId:async()=> 'watch',
      readSavedLinks:type=>readSavedLinks(db,type)});
    expect(await handle({action:'pullSavedItems',type:'FAVORITE'})).toEqual({success:true,action:'pullSavedItems',
      type:'FAVORITE',count:2,items:[{link:'https://b'},{link:'https://a'}]});
    expect(await handle({action:'pullSavedItems',type:'WATCH_LATER'})).toEqual({success:true,action:'pullSavedItems',
      type:'WATCH_LATER',count:1,items:[{link:'https://later'}]});
  } finally {sqlite.close();}
});
