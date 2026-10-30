import {dbFixture,article} from './library-fixture';
import {rssArticleId,rssSourceKey} from '../../src/cloud/rss-identity';
import {crypto} from './k2-crypto';
import {utf8Encode} from '../../src/cloud/types';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from './library-fixture';
import {enabled} from './k2-crypto';
import type {BookFiles} from '../../src/books/files';
import type {RecordDocument} from '../../src/cloud/records';
/** Fully synthetic RSS replay at 1178 library/remaining-row scale. No owner
 * identity, account, body, grant, ciphertext or checkpoint is copied. */
export async function readingThroughputFixture(count=2049){
 const f=await dbFixture(),source='https://reading-scale.invalid/rss',sourceId=await rssSourceKey(source,crypto.sha256),ids:string[]=[],docs:RecordDocument[]=[];
 for(let n=1;n<=Math.max(6542,count);n++)ids.push(await rssArticleId({guid:'synthetic-guid-'+n},crypto.sha256));
 f.sql.transaction(()=>{f.sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://reading-scale.invalid/rss','Synthetic',1,1)");const put=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,1,'Synthetic','original synthetic text',?,?,?,1)");for(let n=1;n<=6542;n++)put.run(n,'https://reading-scale.invalid/'+n,'synthetic-guid-'+n,'synthetic-guid-'+n);})();
 // Add book aliases to actual RSS rows to exercise SQL exclusions at scale.
 // The replay targets use IDs above 3495, never these registered chapters.
 f.sql.transaction(()=>{const book=f.sql.prepare('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES(?,?,?,?,1)'),alias=f.sql.prepare('INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,item_id,url,channel_url,wire_identity) VALUES(?,?,?,?,?,?,?)');let chapter=1;for(let b=0;b<27;b++){const size=b===26?3495-26*130:130,id='synthetic-book-'+b;book.run(id,'fingerprint',size,'{}');for(let n=1;n<=size;n++,chapter++)for(let wire=0;wire<2;wire++)alias.run(id,n,ids[chapter-1]+':'+wire,chapter,'https://reading-scale.invalid/'+chapter,source,wire);}})();
 for(let n=0;n<count;n++){const item=3496+n,id=ids[item-1],value={sourceId,articleIdHash:await crypto.sha256(utf8Encode(id)),sourceDeviceId:'phone',isRead:true,readingProgress:.75,readingPositionBytes:n+3,readingPositionContentHash:'synthetic-anchor',readingPositionChangedAt:100+n,favoriteSaved:n%31===0,favoriteChangedAt:n%31===0?100+n:0,favoriteSortOrder:n,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0};docs.push({kind:'rss-state',value});}
 const metadata=Array.from({length:4},(_,n)=>({kind:'article',value:article({articleId:ids[3495+n],url:'https://reading-scale.invalid/'+(3496+n),rssSourceUrl:source,rssSourceTitle:'Synthetic',title:'Synthetic',contentHtml:null,contentText:'',independentSaved:false,independentChangedAt:0,updatedAt:1,importedAt:1,isRead:true,readingProgress:.75,readingPositionChangedAt:1})})).map((d,n)=>{const {contentText,contentHtml,...value}=d.value;return {...d,value:{...value,guid:'synthetic-guid-'+(3496+n)}};});
 const unavailable=async():Promise<never>=>{throw Error('book body IO forbidden in RSS reading fixture');};const bookFiles:BookFiles={write:unavailable,writeBytes:unavailable,publish:unavailable,stat:unavailable,hash:unavailable,read:unavailable,lines:async function*(){throw Error('book body IO forbidden');},combine:unavailable,remove:unavailable},ports={...f.ports,bookFiles},repo=new SqlLibrarySessionRepository(f.db,ports),adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);
 return {...f,ports,repo,adapter,docs,metadata,ids,source,sourceId};
}
