import fixture from '../fixtures/alias-receive-android.json';
import {initializeSchema} from '../../src/core/schema.ts';
import {SyncSavedStateStore,deviceOrder} from '../../src/sync/saved-state.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import type {WireIncomingArticle} from '../../src/sync/article-batches.ts';
import type {SyncBodyPayload} from '../../src/sync/article-body.ts';
import {decodeChunkData} from '../../src/sync/protocol.ts';
export {fixture};
export type AliasCase=(typeof fixture.cases)[number];
export async function clearAliasFixture(db:SqlDatabase){await db.transaction(['DELETE FROM channels','DELETE FROM sync_saved_states','DELETE FROM sync_article_ids','DELETE FROM local_article_deletions'].map(sql=>({sql})));}
export async function seedAliasCase(db:SqlDatabase,row:AliasCase){
 await initializeSchema(db);await clearAliasFixture(db);await new SyncSavedStateStore(db).initializeDevice('local');
 await db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.example/rss','Feed',1,-1)");
 await db.execute("INSERT INTO articles(id,channel_id,title,description,content,link,guid,is_read,is_saved,reading_progress,dedup_key,fetched_at) VALUES(1,1,'Original RSS','body',?,'https://example.com/alias','feed-guid',1,1,?,'feed-guid',100)",[(row.input as {noStoredBody?:boolean}).noStoredBody?null:'body',Math.fround(.8)]);
 await db.execute("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(1,?,200,3,'old')",[Math.fround(.8)]);
 await db.execute("INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,1,'https://example.com/alias')",[row.articleId]);
 for(const type of ['favorite','watchLater']){
  const f=type==='favorite';await db.execute('INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(1,?,1,?,?)',[type,f?30:40,f?-300:-400]);
  if(!(row.input as {noStates?:boolean}).noStates)await db.execute('INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,?,1,?,1,?,?,?,?)',[row.articleId,type,'https://example.com/alias',f?100:120,f?300:400,'local',deviceOrder('local')]);
 }
}
export function aliasArticle(row:AliasCase):WireIncomingArticle {const c=row.input;return {articleId:row.articleId,sourceDeviceId:c.peer,url:'https://example.com/alias',title:'Remote',siteName:'Feed',excerpt:'body',imageUrl:null,contentHash:'',importedAt:150,updatedAt:150,independentSaved:false,independentChangedAt:0,independentSortOrder:0,rssSourceUrl:'https://feed.example/rss',rssSourceTitle:'Feed',favoriteSaved:c.favorite,favoriteChangedAt:c.favoriteAt,favoriteSortOrder:500,watchLaterSaved:c.later,watchLaterChangedAt:c.laterAt,watchLaterSortOrder:600,deleted:false,deletedAt:0,readingProgress:Math.fround(.2),readingPositionBytes:1,readingPositionContentHash:'remote',readingPositionChangedAt:50,isRead:false};}
export function aliasBody(row:AliasCase):SyncBodyPayload{return {articleId:row.articleId,bodyHash:(row.input as {badHash?:boolean}).badHash?'bad':row.bodyHash,bodyByteCount:row.bodyBytes,chunkSize:row.chunkSize,chunkHashes:row.chunkHashes,metadataOnly:row.input.metadataOnly,chunks:row.input.metadataOnly?[]:[{index:0,hash:row.chunkHashes[0]!,bytes:decodeChunkData(row.encodedBase64)}]};}
export async function aliasOutcome(db:SqlDatabase){
 const items=(await db.query('SELECT a.*,r.position_bytes,r.changed_at AS reading_at FROM articles a LEFT JOIN article_reading_state r ON r.article_id=a.id ORDER BY a.id')).map(r=>({id:Number(r.id),dedupKey:String(r.dedup_key),title:String(r.title),content:r.content??null,progress:Number(r.reading_progress),position:Number(r.position_bytes??0),readingAt:Number(r.reading_at??0),isRead:!!Number(r.is_read)}));
 const entries=(await db.query('SELECT s.article_id,s.save_type,COALESCE(t.created_at,s.changed_at) AS created_at FROM article_saved_states s LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type WHERE s.saved=1 ORDER BY s.save_type,s.article_id')).map(r=>({itemId:Number(r.article_id),type:r.save_type==='favorite'?'FAVORITE':'WATCH_LATER',createdAt:Number(r.created_at)}));
 const states=(await db.query('SELECT * FROM sync_saved_states ORDER BY save_type')).map(r=>({itemId:r.item_id==null?null:Number(r.item_id),type:r.save_type==='favorite'?'FAVORITE':'WATCH_LATER',saved:!!Number(r.saved),changedAt:Number(r.changed_at),sortOrder:Number(r.sort_order),source:String(r.source_device_id)}));
 return {items,entries,states};
}
