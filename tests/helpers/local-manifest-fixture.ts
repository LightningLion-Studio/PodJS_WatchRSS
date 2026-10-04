import fixture from '../fixtures/local-manifest-android.json';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import type {ArticleReceiveFiles} from '../../src/sync/article-receiver.ts';
import type {SyncBodyCodec} from '../../src/sync/article-body.ts';
import {stableArticleId,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {SyncSavedStateStore,deviceOrder} from '../../src/sync/saved-state.ts';
export {fixture};
export async function seedLocalManifestFixture(db:SqlDatabase,files:ArticleReceiveFiles,text:SyncTextPort,codec:SyncBodyCodec,missingMarker="@missing"){
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('local');
 for(const c of fixture.input.channels)await db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(?,?,?,?,?)',[c.id,c.url,c.title,1,0]);
 for(const r of fixture.input.items){let content=r.content==="@missing"?missingMarker:r.content;if(content!==null&&content.length>50000)content=await files.storeText('fixture-large',content);
  await db.execute('INSERT INTO articles(id,channel_id,title,description,content,link,image_url,is_read,reading_progress,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[r.id,r.channelId,r.title,r.description,content,r.url,r.imageUrl,r.isRead?1:0,Math.fround(r.readingProgress),'item-'+r.id,r.fetchedAt]);
  await db.execute('INSERT INTO article_previews(article_id,summary,image_url) VALUES(?,?,?)',[r.id,r.summary,r.previewImageUrl]);
  await db.execute('INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(?,?,?,?,?)',[r.id,Math.fround(r.readingProgress),r.readingPositionChangedAt,r.readingPositionBytes,r.readingPositionContentHash]);
  if(r.originalContent!==null)await db.execute('INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,0,?)',[r.id,r.originalContent]);
  if(r.syncBodyHash)await db.execute('INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(?,NULL,?,?,0,0,?,0)',[r.id,r.content??'',r.syncBodyHash,'[]']);
 }
 for(const s of fixture.input.saves)await db.execute('INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,?,1,?,?)',[s.itemId,s.type,s.createdAt,-s.sortOrder]);
 for(const s of fixture.input.states){const id=await stableArticleId(s.url,text.parseUri,codec);
  if(s.type==='delete'){await db.execute('INSERT INTO local_article_deletions(channel_url,article_url,dedup_key,was_favorite,was_watch_later,changed_at) VALUES(?,?,?,?,?,?)',['watchrss://phone-imports',s.url,id,fixture.input.states.some(t=>t.url===s.url&&t.type==='favorite')?1:0,fixture.input.states.some(t=>t.url===s.url&&t.type==='watchLater')?1:0,s.changedAt]);continue;}
  if(s.itemId!==null)await db.execute('INSERT OR IGNORE INTO sync_article_ids(article_id,item_id,url) VALUES(?,?,?)',[id,s.itemId,s.url]);
  await db.execute('INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,?,?,?,?,?,?,?,?)',[id,s.type,s.itemId,s.url,s.saved?1:0,s.changedAt,s.sortOrder,s.sourceDeviceId,deviceOrder(s.sourceDeviceId)]);
  if(s.itemId!==null&&!s.saved)await db.execute('INSERT OR IGNORE INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,?,0,?,?)',[s.itemId,s.type,s.changedAt,-s.sortOrder]);
 }
}
export async function clearLocalManifestFixture(db:SqlDatabase){await db.transaction(['DELETE FROM channels','DELETE FROM sync_saved_states','DELETE FROM sync_article_ids','DELETE FROM local_article_deletions'].map(sql=>({sql})));}
