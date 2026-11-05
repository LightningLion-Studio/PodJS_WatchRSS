import {BUSINESS_FIELDS,fromWire} from './business';
import {materializeFrozen,type Materialize} from './source';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import type {LocalArticleManifestStore} from '../sync/local-manifest';
/** Uses the frozen legacy reader in its explicit read-only mode: no lookup
 * initialization, body scan, recipe computation, old cursor, or business writes. */
export function watchMaterializer(db:ProjectionSql,metadata:Pick<LocalArticleManifestStore,'cloudRestoreMetadata'>,previousBySource?:(table:string,locator:string)=>Promise<any>,previousById?:(kind:'article',logicalId:string)=>Promise<any>):Materialize {
 return async(table,row)=>{
  if(table==='articles'){
   if(row.__removed){
    const previous=await previousBySource?.(table,String(row.__locator));if(!previous)throw Error('source_tombstone_required');
    const tombstone=(await db.query('SELECT * FROM sync_article_deletions WHERE article_id=?',[previous.meta.logicalId]))[0];if(!tombstone)throw Error('source_tombstone_required');
    const value={...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(tombstone.changed_at),sourceDeviceId:String(tombstone.source_device_id)};
    return [{kind:'article',logicalId:previous.meta.logicalId,value,...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
   }
   if((await db.query('SELECT 1 FROM article_register_state WHERE item_id=?',[row.id])).length)return [];
   if((await db.query('SELECT 1 FROM sync_book_aliases WHERE item_id=?',[row.id])).length)return []; // Stable book/chapter identities have their own records.
   const page=await metadata.cloudRestoreMetadata({itemIds:[Number(row.id)],limit:1},undefined,true);
   if(page.articles.length!==1)throw Error('source_identity_missing');
   const record=page.articles[0]!,value=Object.fromEntries(Object.entries(record).filter(([key])=>BUSINESS_FIELDS.article.includes(key)));
   // fetched_at is refreshed by RSS acquisition and does not prove first
   // library admission. Only an existing explicit import witness supplies it.
   const historical=(await db.query('SELECT imported_at FROM article_sync_encoding_cache WHERE item_id=? AND imported_at>0',[row.id]))[0],addedAt=Number(historical?.imported_at??0);
   value.importedAt=addedAt;
   return [{kind:'article',logicalId:record.articleId,value,...(addedAt>0?{addedAtMillis:addedAt}:{})}];
  }
  if(table==='sync_article_deletions'){
   const previous=await previousById?.('article',String(row.article_id));if(!previous)return materializeFrozen(table,row);
   return [{kind:'article',logicalId:String(row.article_id),value:{...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(row.changed_at),sourceDeviceId:String(row.source_device_id)},...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
  }
  if(table==='channels'){
   const url=String(row.url);
   // Non-subscription builtin/import containers are represented by their
   // stable article/book entities, exactly as the old source protocol.
   if(!/^https?:\/\//i.test(url)||/^https?:\/\/watchrss\.local\/import-/.test(url))return [];
   const stored=(await db.query('SELECT * FROM sync_source_states WHERE url=?',[url]))[0];
   const device=String((await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??'');if(!device)throw Error('source_identity_missing');
   const same=stored&&Number(stored.deleted)===0&&stored.title===row.title&&(String(stored.description).trim()?stored.description:stored.site_url)===(row.description??'')&&stored.image_url===row.image_url&&Number(stored.sort_order)===-Number(row.sort_order)&&!!Number(stored.is_pinned)===!!Number(row.is_pinned);
   const value={url,sourceDeviceId:same?String(stored.source_device_id):device,title:String(row.title),description:same?String(stored.description):String(row.description??''),siteUrl:same?stored.site_url:null,imageUrl:row.image_url??null,createdAt:Number(row.created_at),updatedAt:same?Number(stored.updated_at):Math.max(Number(stored?.updated_at??-1)+1,-Number(row.sort_order),Number(row.created_at)),sortOrder:Number(row.sort_order)===0?0:-Number(row.sort_order),isPinned:!!Number(row.is_pinned),deleted:false,deletedAt:0};
   return [{kind:'source',logicalId:url,value,...(value.createdAt>0?{addedAtMillis:value.createdAt}:{})}];
  }
  return materializeFrozen(table,row);
 };
}
