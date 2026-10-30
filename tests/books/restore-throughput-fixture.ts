import index from '../fixtures/restore1177-book-index.json';
import {bookFixture} from './fixture';
import {sha} from '../sync/ble-v2-fixture';
import {bookId,bookArticleId,type BookState,type BookReading} from '../../src/books/protocol';
import type {RecordDocument} from '../../src/cloud/records';
/** Shape-only owner index. All identities/text below are new synthetic values.
 * The two unrelated legacy imports remain pending: normal metadata replay must
 * not retry their body materialization for each already registered book. */
export async function restoreBookFixture(){
 const f=await bookFixture(),states:BookState[]=[],readings:BookReading[]=[],items:{book:number;chapter:number;id:number;url:string;wire:string;bid:string}[]=[];let item=0;
 for(const b of index.books){const fingerprint=sha('synthetic-fingerprint-'+b.index),id=await bookId(fingerprint,f.bookPorts.sha256);states.push({bookId:id,fingerprint,title:'Book '+b.index,chapterCount:b.chapters,deletedChapters:b.deletedChapters,deletionClock:b.deletedChapters.length?10:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:b.chapters===1?'https://watchrss.local/import-content/txt/synthetic-'+b.index:'https://watchrss.local/import-'+(b.kind==='epub'?'epub':'txt-novel')+'/synthetic-'+b.index,kind:b.kind as 'txt'|'epub'});}
 const chapterIds=new Map<string,string>();for(const s of states)for(let n=1;n<=s.chapterCount;n++)chapterIds.set(s.bookId+':'+n,await bookArticleId(s.bookId,n,f.bookPorts.sha256));
 f.sql.transaction(()=>{
  f.sql.exec("UPDATE sync_book_context SET remote=1 WHERE id=1");let channelId=Number((f.sql.query('SELECT COALESCE(MAX(id),0) n FROM channels').get() as any).n);
  const channel=new Map<string,number>(),addChannel=(url:string)=>{const old=channel.get(url);if(old)return old;const id=++channelId;f.sql.query('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(?,?,?,1,1)').run(id,url,'Synthetic');channel.set(url,id);return id;};
  const shared=addChannel('https://watchrss.local/import-content');
  const book=f.sql.prepare('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,package_path,package_sha256,package_bytes,registration_complete) VALUES(?,?,?,?,?,?,1,1)'),article=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(?,?,'Chapter','original',?,?,1,0,0)"),alias=f.sql.prepare('INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,item_id,url,channel_url,wire_identity) VALUES(?,?,?,?,?,?,?)'),chapter=f.sql.prepare('INSERT INTO sync_book_chapters VALUES(?,?,?,?,?,?)');
  for(const b of index.books){const s=states[b.index],channelUrl=b.chapters===1?'https://watchrss.local/import-content':s.sourceUrl!,ch=b.chapters===1?shared:addChannel(channelUrl),path='books/'+s.bookId+'.jsonl';f.data.set(path,new Uint8Array([10]));book.run(s.bookId,s.fingerprint,s.chapterCount,JSON.stringify(s),path,sha(new Uint8Array([10])));
   for(let n=1;n<=b.chapters;n++){const url=b.chapters===1?s.sourceUrl!:s.sourceUrl+'/chapter/'+n,wire=sha(url),bid=chapterIds.get(s.bookId+':'+n)!,present=!b.deletedChapters.includes(n),iid=present?++item:null;
    if(iid!==null){article.run(iid,ch,url,wire);f.sql.query('INSERT INTO sync_article_ids VALUES(?,?,?)').run(wire,iid,url);items.push({book:b.index,chapter:n,id:iid,url,wire,bid});}
    chapter.run(s.bookId,n,bid,iid,url,sha('chapter-'+n));alias.run(s.bookId,n,bid,iid,url,channelUrl,0);alias.run(s.bookId,n,wire,iid,url,channelUrl,1);
   }
  }
  for(const g of index.legacyGroups){const source='https://watchrss.local/import-txt-novel/pending-'+g.index,ch=addChannel(source);
   for(let n=1;n<=g.rows;n++){const iid=++item,url=source+'/chapter/'+n,wire=sha(url);article.run(iid,ch,url,wire);f.sql.query('INSERT INTO sync_article_ids VALUES(?,?,?)').run(wire,iid,url);f.sql.query("INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(?,NULL,?,'pending',1,131072,'[]',1)").run(iid,'pending-'+g.index+'-'+n);}
  }
  let feed=0;while(channelId<index.channels){feed=addChannel('https://feed.invalid/'+channelId);}
  while(item<index.articles){const iid=++item,url='https://article.invalid/'+iid;article.run(iid,feed,url,sha(url));}
  // The copied numeric index includes dangling reading metadata for deleted
  // chapters. Seed the same valid typed state without fabricating physical rows.
  for(const b of index.books){const s=states[b.index];for(let n=1;n<=b.reading;n++){const r:BookReading={bookId:s.bookId,chapterIndex:n,isRead:true,readingProgress:.5,readingPositionBytes:3,readingPositionContentHash:'original',readingPositionChangedAt:100+n,sourceDeviceId:'watch'};readings.push(r);f.sql.query('INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source) VALUES(?,?,?,?,?,?,?,?,?)').run(s.bookId,n,JSON.stringify(r),1,.5,100+n,3,'original','watch');const ids=items.filter(v=>v.book===b.index&&v.chapter===n);for(const v of ids){f.sql.query('UPDATE articles SET is_read=1,reading_progress=.5 WHERE id=?').run(v.id);f.sql.query("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(?,.5,?,3,'original')").run(v.id,100+n);}}
  }
  f.sql.exec('DELETE FROM sync_book_events;DELETE FROM sync_book_reading_dirty;DELETE FROM sync_book_display_dirty;UPDATE sync_book_context SET remote=0 WHERE id=1');
 })();
 let hydrates=0;
 const files={...f.ports.files,hydrate:async(v:string)=>{if(v.startsWith('pending-')){hydrates++;const bits=v.split('-'),n=Number(bits[2]);if(n===(Number(bits[1])===0?62:190))throw Error('synthetic pending original');return 'synthetic original chapter '+n;}return v;}};
 const ports={...f.ports,files,bookFiles:f.files};
 const docs:RecordDocument[]=[...states.map(value=>({kind:'book',value} as RecordDocument)),...readings.map(value=>({kind:'book-reading',value} as RecordDocument))];
 // The remaining retained metadata actively changes real chapter rows. This
 // exercises transactional native projection, not only idempotent no-op replay.
 const used=new Set(readings.map(r=>r.bookId+':'+r.chapterIndex));for(const v of items){const s=states[v.book],key=s.bookId+':'+v.chapter;if(used.has(key))continue;docs.push({kind:'book-reading',value:{bookId:s.bookId,chapterIndex:v.chapter,isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:1000+v.chapter,sourceDeviceId:'phone'}});if(docs.length===index.retained)break;}
 if(docs.length!==index.retained)throw Error('fixture retained shape');
 return {...f,ports,states,readings,items,docs,index,hydrates:()=>hydrates};
}
