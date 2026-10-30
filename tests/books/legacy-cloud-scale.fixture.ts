import {bookFixture} from './fixture';
import {sha} from '../sync/ble-v2-fixture';
import {article} from '../cloud/library-fixture';
import {bookId,bookFingerprint,chapterHash,bookArticleId,type BookState,type BookReading} from '../../src/books/protocol';
import type {RecordDocument} from '../../src/cloud/records';
/** Synthetic 1 EPUB : 7 TXT scenario, conditional on the eight-row 1179 sample.
 * Counts match the library scale; the sample is not a population estimate. */
export async function legacyCloudScaleFixture(prefix=1801){
 const f=await bookFixture(),states:BookState[]=[],all:any[]=[],packages:any[]=[];
 for(let b=0;b<27;b++){
  const count=b===0?500:b===1?2970:1,kind=b===0?'epub':'txt',source='https://watchrss.local/import-'+(kind==='epub'?'epub':'txt-novel')+'/synthetic-'+b,chapters:any[]=[],hashes:string[]=[];
  for(let n=1;n<=count;n++){const body='Synthetic original '+b+':'+n,title='Chapter '+n,url=source+'/chapter/'+n;chapters.push({chapterIndex:n,title,contentText:body,contentHtml:null,url});hashes.push(await chapterHash(n,title,body,f.bookPorts.sha256));}
  const fingerprint=await bookFingerprint(hashes,f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256),state:BookState={bookId:id,fingerprint,title:'Synthetic book '+b,chapterCount:count,deletedChapters:b>1?[1]:[],deletionClock:b>1?1:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:source,kind};states.push(state);
  const bytes=new TextEncoder().encode([JSON.stringify({format:'watchrss-book',version:1,title:state.title,chapterCount:count,sourceUrl:source,kind}),...chapters.map(c=>JSON.stringify(c))].join('\n')+'\n'),path='books/'+id+'.jsonl';f.data.set(path,bytes);packages.push({path,hash:sha(bytes),size:bytes.length});
  for(let n=0;n<chapters.length;n++){const c=chapters[n],wire=sha(c.url),canonical=await bookArticleId(id,n+1,f.bookPorts.sha256),encoded=await f.ports.codec.encode(c);all.push({book:b,chapter:n+1,state,url:c.url,wire,canonical,chapterHash:hashes[n],body:c.contentText,bodyHash:sha(encoded),bodyBytes:encoded.length,encoded});}
 }
 f.sql.transaction(()=>{
  f.sql.exec('UPDATE sync_book_context SET remote=1 WHERE id=1');let channel=Number((f.sql.query('SELECT max(id) n FROM channels').get() as any).n??0),item=0;
  const insertBook=f.sql.prepare('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,package_path,package_sha256,package_bytes,registration_complete) VALUES(?,?,?,?,?,?,?,1)'),insertAlias=f.sql.prepare('INSERT INTO sync_book_aliases VALUES(?,?,?,?,?,?,?)');
  for(let b=0;b<27;b++){const s=states[b],p=packages[b];insertBook.run(s.bookId,s.fingerprint,s.chapterCount,JSON.stringify(s),p.path,p.hash,p.size);if(b<2){channel++;f.sql.query('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(?,?,?,1,1)').run(channel,s.sourceUrl!,s.title);}for(const v of all.filter(r=>r.book===b)){
   const iid=b<2?++item:null;v.item=iid;if(iid){f.sql.query('INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,1)').run(iid,channel,'Chapter '+v.chapter,v.body,v.url,v.wire,v.wire);f.sql.query('INSERT INTO sync_article_ids VALUES(?,?,?)').run(v.wire,iid,v.url);f.sql.query("INSERT INTO article_sync_content VALUES(?,NULL,?,?,?,?,?,?)").run(iid,v.body,v.bodyHash,v.bodyBytes,131072,JSON.stringify([v.bodyHash]),new TextEncoder().encode(v.body).length);f.sql.query('INSERT INTO article_sync_encoding_cache(item_id,body_hash,content_hash) VALUES(?,?,?)').run(iid,v.bodyHash,sha(v.body));}
   f.sql.query('INSERT INTO sync_book_chapters VALUES(?,?,?,?,?,?)').run(s.bookId,v.chapter,v.canonical,iid,v.url,v.chapterHash);for(const [id,bit]of [[v.canonical,0],[v.wire,1]])insertAlias.run(s.bookId,v.chapter,id,iid,v.url,s.sourceUrl,bit);
  }}
  while(channel<18){channel++;f.sql.query('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(?,?,\'Feed\',1,1)').run(channel,'https://feed.invalid/'+channel);}
  while(item<6542){item++;f.sql.query('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,\'Item\',\'public body\',?,?,1)').run(item,channel,'https://article.invalid/'+item,'filler-'+item);}
  for(const v of all.filter(v=>v.item).slice(0,1219)){const r:BookReading={bookId:v.state.bookId,chapterIndex:v.chapter,isRead:true,readingProgress:.5,readingPositionBytes:3,readingPositionContentHash:'original',readingPositionChangedAt:100+v.chapter,sourceDeviceId:'watch'};f.sql.query('INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source) VALUES(?,?,?,?,?,?,?,?,?)').run(r.bookId,r.chapterIndex,JSON.stringify(r),1,.5,r.readingPositionChangedAt,3,'original','watch');f.sql.query("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(?,.5,?,3,'original')").run(v.item,r.readingPositionChangedAt);f.sql.query('UPDATE articles SET is_read=1,reading_progress=.5 WHERE id=?').run(v.item);}
  f.sql.exec('DELETE FROM sync_book_events;DELETE FROM sync_book_reading_dirty;DELETE FROM sync_book_display_dirty;UPDATE sync_book_context SET remote=0 WHERE id=1');
 })();
 const epub=all.filter(v=>v.book===0),txt=all.filter(v=>v.book===1),selected:any[]=[],docs:RecordDocument[]=[],values:BookReading[]=[];let ei=0,ti=0;
 for(let n=0;n<3351;n++){
  const v=n%8===0?epub[ei++]:txt[ti++],url=v.url.replace('https://watchrss.local/','https://www.watchrss.local/'),readingClock=10000+n;selected.push(v);const {contentText,contentHtml,...value}=article({articleId:sha(url),url,rssSourceUrl:v.state.sourceUrl,rssSourceTitle:v.state.title,title:'Legacy chapter '+v.chapter,excerpt:'Synthetic metadata '+'.'.repeat(512),contentHash:sha(v.body),contentText:'',contentHtml:null,independentSaved:false,independentChangedAt:0,isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:readingClock});docs.push({kind:'article',value:{...value,bookIndexRetired:false}});values.push({bookId:v.state.bookId,chapterIndex:v.chapter,isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:readingClock,sourceDeviceId:'phone'});
 }
 for(let at=0;at<prefix;at+=100)await f.store.mergeReadingBatch(values.slice(at,Math.min(prefix,at+100)),{capture:false});
 return {...f,ports:{...f.ports,bookFiles:f.files},states,docs,values,selected,packages,prefix,counts:{articles:6542,books:27,chapters:3495,aliases:6990,retained:3351,prefix,remaining:3351-prefix,scenario:'1 EPUB : 7 TXT conditional sample expansion, not owner population'}};
}
