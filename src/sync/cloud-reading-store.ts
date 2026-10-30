import type {SqlDatabase,SqlParams} from '../core/types';
import type {ExportedArticle} from './article-export';
import {revisionGuard,libraryRevision} from './revision';
import {SyncSavedStateStore,deviceOrder} from './saved-state';
import {ArticleKeepStore} from './article-keep';
import {onlyChangedSql} from '@podjs/framework/sql-changes';
type Statement={sql:string;params?:SqlParams};
/** Cloud reading clocks act on an existing identity. They neither certify a
 * body nor materialize an absent article. Decisions use live SQL at commit. */
export class CloudReadingStore {
 private saved:SyncSavedStateStore;private keeps:ArticleKeepStore;
 constructor(private db:SqlDatabase,private prepareMigration?:(ids:readonly number[])=>Promise<Statement[]>){this.saved=new SyncSavedStateStore(db);this.keeps=new ArticleKeepStore(db);}
 async merge(articles:readonly ExportedArticle[],check:()=>void,metadata=false,expectedRevision?:number){
  await this.keeps.initialize();let changed=0,revision=await libraryRevision(this.db);const remaining:ExportedArticle[]=[];let cacheSafe=expectedRevision===revision;
  for(let at=0;at<articles.length;at+=20){check();const part=articles.slice(at,at+20),ids=part.map(a=>a.cloudReadingItemId??0),marks=ids.map(()=>'?').join(',');
   const observed=await libraryRevision(this.db);if(observed!==revision)cacheSafe=false;revision=observed;
   const rows=await this.db.query(`SELECT a.id,a.link,a.guid,a.dedup_key,a.title,a.description,a.image_url,a.fetched_at,ch.url source,m.article_id bound,k.article_id canonical,d.changed_at deleted_clock,d.source_order deleted_source FROM articles a JOIN channels ch ON ch.id=a.channel_id LEFT JOIN sync_article_ids m ON m.item_id=a.id LEFT JOIN cloud_reading_lookup k ON k.item_id=a.id LEFT JOIN sync_article_deletions d ON d.article_id=COALESCE(m.article_id,k.article_id) WHERE a.id IN (${marks}) AND NOT EXISTS(SELECT 1 FROM sync_book_aliases b JOIN sync_books s ON s.book_id=b.book_id WHERE b.item_id=a.id AND s.registration_complete=1) AND NOT EXISTS(SELECT 1 FROM article_register_state p WHERE p.item_id=a.id)`,ids);
   const byId=new Map(rows.map(r=>[Number(r.id),r])),statements:Statement[]=[revisionGuard(revision)];let accepted=0,identityChanged=false;const migrated:number[]=[];
   for(const a of part){check();const r=byId.get(a.cloudReadingItemId??0);if(!r||a.deleted||a.contentText||a.contentHtml||r.source!==a.rssSourceUrl||String(r.link||r.guid||r.dedup_key)!==a.url||r.canonical!==a.articleId){remaining.push(a);continue;}
    for(const key of ['updatedAt','readingPositionBytes','readingPositionChangedAt','favoriteChangedAt','favoriteSortOrder','watchLaterChangedAt','watchLaterSortOrder'] as const)if(!Number.isSafeInteger(a[key])||a[key]<0)throw Error('cloud_reading_state_invalid');
    if(!Number.isFinite(a.readingProgress)||!a.sourceDeviceId)throw Error('cloud_reading_state_invalid');
    const live=Math.max(a.updatedAt,a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt);if(r.deleted_clock!=null&&(Number(r.deleted_clock)>live||Number(r.deleted_clock)===live&&String(r.deleted_source)>=deviceOrder(a.sourceDeviceId)))continue;
    accepted++;migrated.push(Number(r.id));const item=Number(r.id),bound=String(r.bound??a.articleId),clock=a.readingPositionChangedAt||a.updatedAt,progress=Math.fround(Math.max(0,Math.min(1,a.readingProgress)));
    statements.push({sql:'INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,?,?) ON CONFLICT(article_id) DO NOTHING',params:[bound,item,a.url]});
    if(!r.bound)statements.push({sql:'UPDATE cloud_reading_lookup SET bound=?,bound_hash=article_hash WHERE item_id=? AND bound IS NULL',params:[bound,item]});
    statements.push({sql:'INSERT INTO sync_article_aliases(item_id,article_id) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id',params:[item,bound]},
     {sql:'INSERT INTO cloud_rss_article_ids(item_id,article_id) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id',params:[item,a.articleId]},
     {sql:'UPDATE cloud_reading_lookup SET pool=? WHERE item_id=?',params:[a.articleId,item]});
    // Bind saves before applying their live clock/source tie-break rules.
    statements.push({sql:`INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) SELECT ?,s.save_type,s.article_id,?,s.saved,s.changed_at,-s.sort_order,i.device_id,i.device_order FROM article_saved_states s CROSS JOIN sync_local_identity i WHERE s.article_id=? AND i.id=1 ON CONFLICT(article_id,save_type) DO NOTHING`,params:[bound,a.url,item]});
    const localSource=`COALESCE((SELECT reading_source FROM cloud_article_state WHERE article_id=? AND reading_clock=article_reading_state.changed_at),(SELECT device_id FROM sync_local_identity WHERE id=1),'')`,wins=`(excluded.changed_at>article_reading_state.changed_at OR (excluded.changed_at=article_reading_state.changed_at AND (? > ${localSource} OR (? = ${localSource} AND (?=0 OR ?=(SELECT is_read FROM articles WHERE id=article_reading_state.article_id))))))`,flags=[a.sourceDeviceId,bound,a.sourceDeviceId,bound,a.isRead?1:0,a.isRead?1:0];
    statements.push({sql:`UPDATE articles SET is_read=? WHERE id=? AND (NOT EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=articles.id) OR EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=articles.id AND (? > changed_at OR (?=changed_at AND (? > ${localSource} OR (?=${localSource} AND ?=0))))))`,params:[a.isRead?1:0,item,clock,clock,a.sourceDeviceId,bound,a.sourceDeviceId,bound,a.isRead?1:0]},
     {sql:`INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) VALUES(?,?,?,?,?,NULL) ON CONFLICT(article_id) DO UPDATE SET progress=CASE WHEN ${wins} THEN excluded.progress ELSE article_reading_state.progress END,position_bytes=CASE WHEN ${wins} THEN excluded.position_bytes ELSE article_reading_state.position_bytes END,position_hash=CASE WHEN ${wins} THEN excluded.position_hash ELSE article_reading_state.position_hash END,state_json=CASE WHEN ${wins} THEN NULL ELSE article_reading_state.state_json END,changed_at=max(article_reading_state.changed_at,excluded.changed_at)`,params:[item,progress,clock,a.readingPositionBytes,a.readingPositionContentHash,...flags,...flags,...flags,...flags]},
     {sql:'UPDATE articles SET reading_progress=(SELECT progress FROM article_reading_state WHERE article_id=articles.id) WHERE id=?',params:[item]},
     {sql:`INSERT INTO cloud_article_state(article_id,content_hash,body_hash,reading_clock,reading_source) SELECT ?,?,'',?,? WHERE EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=? AND changed_at=?) ON CONFLICT(article_id) DO UPDATE SET reading_clock=excluded.reading_clock,reading_source=excluded.reading_source WHERE excluded.reading_clock>cloud_article_state.reading_clock OR (excluded.reading_clock=cloud_article_state.reading_clock AND excluded.reading_source>=cloud_article_state.reading_source)`,params:[bound,a.contentHash,clock,a.sourceDeviceId,item,clock]});
    for(const type of ['favorite','watchLater'] as const)statements.push(...this.saved.remoteStatements({articleId:bound,url:a.url,type,saved:a[`${type}Saved`],changedAt:a[`${type}ChangedAt`],sortOrder:a[`${type}SortOrder`],sourceDeviceId:a.sourceDeviceId}));
    statements.push(...this.keeps.record(bound,a.url,Math.max(a.updatedAt,a.favoriteChangedAt,a.watchLaterChangedAt),a.sourceDeviceId,'?',[item],[]));
    if(metadata){identityChanged ||= r.title!==a.title;statements.push({sql:'UPDATE articles SET title=?,description=?,image_url=?,fetched_at=? WHERE id=? AND fetched_at<=?',params:[a.title,a.excerpt||null,a.imageUrl,a.updatedAt,item,a.updatedAt]});for(const table of ['article_previews','article_original_previews'])statements.push({sql:`INSERT INTO ${table}(article_id,summary,image_url) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM articles WHERE id=? AND fetched_at<=?) ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url`,params:[item,a.excerpt||null,a.imageUrl,item,a.updatedAt]});}
   }
   if(!accepted)continue;
   // Capture the revision INSIDE this transaction. A concurrent UI write after
   // commit cannot accidentally be classified as one of our reading updates.
   statements.push({sql:'INSERT INTO cloud_reading_commit(id,revision) SELECT 1,revision FROM sync_library_revision WHERE id=1 ON CONFLICT(id) DO UPDATE SET revision=excluded.revision'});
   if(!this.db.transactionChanges)throw Error('cloud_reading_counts_unavailable');const migration=await this.prepareMigration?.(migrated)??[];statements.splice(1,0,...migration);check();const counts=await this.db.transactionChanges(statements.map(s=>({...s,sql:s.sql.startsWith('INSERT INTO cloud_reading_commit')?s.sql:onlyChangedSql(s.sql)})));changed+=counts.slice(1,-1).some(n=>n>0)?accepted:0;
   const committed=Number((await this.db.query('SELECT revision FROM cloud_reading_commit WHERE id=1'))[0].revision);
   if(identityChanged)cacheSafe=false;revision=committed;
  }
  return {changed,remaining,revision:cacheSafe?revision:-1};
 }
}
