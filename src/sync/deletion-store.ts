import {ArticleKeepStore} from './article-keep';
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import {SyncSavedStateStore,deviceOrder} from './saved-state.ts';
import {rebuildArticleBody,requireMetadataOnlyBody,type SyncBodyCodec,type SyncBodyPayload} from './article-body.ts';
import type {WireIncomingArticle} from './article-batches.ts';
import type {LocalBodyResolver} from './article-receiver.ts';
import {libraryRevision,revisionGuard} from './revision.ts';
/** Deletion has an independent native conflict clock. Body validation and the
 * target lookup occur before one revision-guarded article/state transaction. */
export class SyncArticleDeletionStore {
 private readonly saved:SyncSavedStateStore;
 constructor(private readonly db:SqlDatabase,private readonly codec:SyncBodyCodec,private readonly resolveLocal:LocalBodyResolver,private readonly onItemsRemoved?:(ids:number[])=>Promise<void>){this.saved=new SyncSavedStateStore(db);}
 async receive(article:WireIncomingArticle,payload:SyncBodyPayload,peer:string,authoritative=false):Promise<number>{
  if(!this.db.transactionChanges)throw new Error('Deletion requires committed transaction counts');
  if(!article.deleted||article.articleId!==payload.articleId)throw new Error('Invalid deletion identity');
  if(!Number.isSafeInteger(article.deletedAt))throw new Error('Invalid deletion clock');
  if(!(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1')).length)throw new Error('Initialize sync identity first');
  const keep=await new ArticleKeepStore(this.db).lookup(article.articleId,article.url);
  const revision=await libraryRevision(this.db),local=await this.resolveLocal(article,keep?.item_id==null?undefined:Number(keep.item_id));
  if(payload.metadataOnly)await requireMetadataOnlyBody(payload,local?.body??null,!!local?.available,!!local?.hasStoredBody,this.codec);
  else await rebuildArticleBody(payload,local?.available?local.body:null,this.codec);
  const incomingClock=Math.max(article.updatedAt,article.independentChangedAt,article.favoriteChangedAt,article.watchLaterChangedAt,article.deletedAt);
  if(!authoritative&&keep&&(Number(keep.changed_at)>incomingClock||Number(keep.changed_at)===incomingClock&&String(keep.source_order)>deviceOrder(article.sourceDeviceId||peer)))return 0;
  // A delayed delete must not undo a later, durably received keep decision.
  // Encoding-cache provenance is an accepted sync receipt, not a feed fetch.
  if(local&&!authoritative){const live=(await this.db.query('SELECT updated_at,source_device_id FROM article_sync_encoding_cache WHERE item_id=?',[local.itemId]))[0];
   const clock=Math.max(article.updatedAt,article.independentChangedAt,article.favoriteChangedAt,article.watchLaterChangedAt,article.deletedAt);
   if(live&&(Number(live.updated_at)>clock||Number(live.updated_at)===clock&&deviceOrder(String(live.source_device_id))>deviceOrder(article.sourceDeviceId||peer)))return 0;
  }
  const statements:{sql:string;params?:SqlParams}[]=[revisionGuard(revision)],counted:number[]=[];let deletionIndex=-1;
  if(authoritative||article.deletedAt>0){
   const wins=`(?=1 OR NOT EXISTS(SELECT 1 FROM sync_article_deletions WHERE article_id=?) OR ?>COALESCE((SELECT changed_at FROM sync_article_deletions WHERE article_id=?),0) OR (?=COALESCE((SELECT changed_at FROM sync_article_deletions WHERE article_id=?),0) AND ?>COALESCE((SELECT source_order FROM sync_article_deletions WHERE article_id=?),'')))`;
   const flags=[authoritative?1:0,article.articleId,article.deletedAt,article.articleId,article.deletedAt,article.articleId,deviceOrder(peer),article.articleId];
   if(local){
    statements.push({sql:`INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
     SELECT ?,save_type,NULL,?,0,?,0,?,? FROM article_saved_states WHERE article_id=? AND saved=1 AND ${wins}
     ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=NULL,url=excluded.url,saved=0,changed_at=excluded.changed_at,sort_order=0,source_device_id=excluded.source_device_id,source_order=excluded.source_order`,params:[article.articleId,article.url,article.deletedAt,peer,deviceOrder(peer),local.itemId,...flags]});
    deletionIndex=statements.length;statements.push({sql:`DELETE FROM articles WHERE id=? AND ${wins}`,params:[local.itemId,...flags]});
   }
   counted.push(statements.length);
   statements.push({sql:`INSERT INTO sync_article_deletions(article_id,url,changed_at,source_device_id,source_order) SELECT ?,?,?,?,? WHERE ${wins}
    ON CONFLICT(article_id) DO UPDATE SET url=excluded.url,changed_at=excluded.changed_at,source_device_id=excluded.source_device_id,source_order=excluded.source_order`,params:[article.articleId,article.url,article.deletedAt,peer,deviceOrder(peer),...flags]});
  }
  for(const type of ['favorite','watchLater'] as const){const next=this.saved.remoteStatements({articleId:article.articleId,url:article.url,type,saved:article[`${type}Saved`],changedAt:article[`${type}ChangedAt`],sortOrder:0,sourceDeviceId:peer},{authoritative,tombstone:true});if(next.length)counted.push(statements.length);statements.push(...next);}
  const changes=await this.db.transactionChanges(statements);if(local&&deletionIndex>=0&&changes[deletionIndex]!>0)await this.onItemsRemoved?.([local.itemId]);return counted.some(i=>changes[i]!>0)?1:0;
 }
}
