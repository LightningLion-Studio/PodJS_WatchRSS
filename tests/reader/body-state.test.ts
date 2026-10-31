import {expect,test} from 'bun:test';
import {fixture} from '../sync/ble-v2-fixture';
import {readReaderBody,readerBodyState} from '../../src/reader/body-state';
import {ImportedTextStore} from '../../src/reader/imported-text';
const link='https://watchrss.local/import-txt-novel/book/chapter/1811';
test('production reader body boundary distinguishes restore-pending, missing markers, empty and available bodies without preview promotion',async()=>{
 const f=await fixture();let file=true,reads=0,bodies=0;
 const store=new ImportedTextStore({stat:async()=>({file,size:100}),read:async()=>{reads++;return new Uint8Array();}});
 try{
  f.sql.run("INSERT INTO channels(id,url,title,created_at) VALUES(90,'book','Book',0)");
  f.sql.run('INSERT INTO articles(id,channel_id,title,content,description,link,dedup_key,fetched_at) VALUES(1811,90,?,?,?,?,?,0)',['Chapter','watchrss-watch-content:chapter.txt','preview only',link,'chapter']);
  const marker=await readReaderBody(f.db,store,'1811',link,async()=>{bodies++;return 'wrong fallback';},'preview');
  expect(marker).toMatchObject({rawContent:'',importedText:{byteLength:100,chunkCount:1}});expect(bodies).toBe(0);expect(reads).toBe(0);
  file=false;expect(await readReaderBody(f.db,store,'1811',link,async()=>'', 'preview')).toEqual({rawContent:'',readerBodyState:'failed'});
  f.sql.run("INSERT INTO article_register_state(article_id,item_id,body_pending,state_json,raw_json) VALUES('chapter',1811,1,'{}','{}')");
  expect(await readReaderBody(f.db,store,'1811',link,async()=>{throw Error('must not hydrate pending body');},'preview')).toEqual({rawContent:'',readerBodyState:'restoring'});
  f.sql.run('DELETE FROM article_register_state');f.sql.run('UPDATE articles SET content=NULL WHERE id=1811');
  expect(await readReaderBody(f.db,store,'1811',link,async()=>null,'preview')).toEqual({rawContent:'',readerBodyState:'failed'});
  expect(await readReaderBody(f.db,store,'1811',link,async()=>'real chapter','preview')).toEqual({rawContent:'real chapter'});
  expect(await readReaderBody(f.db,store,'1811','https://example.test/rss',async()=>null,'RSS description')).toEqual({rawContent:'RSS description'});
 }finally{f.sql.close();}
});

test('an imported image-only chapter remains readable, while a blank restored descriptor has an explicit state',()=>{
 const article={id:'1',title:'Chapter',link,content:''};
 expect(readerBodyState(article)).toBe('failed');
 expect(readerBodyState({...article,readerBodyState:'restoring'})).toBe('restoring');
 expect(readerBodyState({...article,contentBlocks:[{type:'image',url:'https://example.test/page.jpg'}]})).toBeUndefined();
});
