import type {SqlDatabase,SqlParams} from '../core/types';
import type {ExportedArticle} from '../sync/article-export';
import {libraryRevision} from '../sync/revision';
import {utf8Encode} from '../cloud/types';
import {legacyWebArticleId,canonicalRssUrl} from '../cloud/rss-identity';
import type {BookReading} from './protocol';
import type {SqlBookStore} from './store';
type Row=Record<string,unknown>;type Predicate={sql:string;params:SqlParams};
const str=(v:unknown)=>String(v??''),marks=(values:readonly unknown[])=>values.map(()=>'?').join(',');
export const legacyBookReadingArticle=(a:ExportedArticle)=>!a.deleted&&!a.independentSaved&&!a.contentText&&!a.contentHtml&&/^https:\/\/watchrss\.local\/import-(?:epub|txt-novel)\//i.test(a.rssSourceUrl??'')&&!!(a.isRead||a.readingProgress||a.readingPositionChangedAt||a.readingPositionBytes||a.favoriteSaved||a.favoriteChangedAt||a.watchLaterSaved||a.watchLaterChangedAt);
const native=(keys:readonly string[]):Predicate=>({sql:`m.item_id IN(SELECT item_id FROM sync_article_ids WHERE article_id IN(${marks(keys)}) UNION SELECT item_id FROM sync_article_aliases WHERE article_id IN(${marks(keys)}))`,params:[...keys,...keys]});
/** Legacy records remain retained. Only a unique registered alias can carry
 * clocks to a chapter; neither body certification nor record retirement occurs. */
export async function mergeLegacyBookReading(db:SqlDatabase,store:SqlBookStore,articles:readonly ExportedArticle[],check:()=>void){
 let changed=0;const remaining:ExportedArticle[]=[];
 for(let at=0;at<articles.length;at+=50){check();const part=articles.slice(at,at+50),ids=part.map(a=>a.articleId),protectedIds=new Set((await db.query('SELECT article_id FROM article_register_state WHERE article_id IN('+marks(ids)+')',ids)).map(r=>str(r.article_id)));
  await store.captureReading();check();const revision=await libraryRevision(db),readings:BookReading[]=[],guards:{sql:string;params?:SqlParams}[]=[];
  const select='SELECT m.*,b.chapter_count FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE b.registration_complete=1 AND ';
  const bindings=await db.query('SELECT article_id,item_id FROM sync_article_ids WHERE article_id IN('+marks(ids)+') UNION SELECT article_id,item_id FROM sync_article_aliases WHERE article_id IN('+marks(ids)+')',[...ids,...ids]),items=new Map<string,number[]>();
  for(const r of bindings){const id=str(r.article_id),item=Number(r.item_id);if(item>0)items.set(id,[...(items.get(id)??[]),item]);}
  const urls=part.map(a=>a.url),physical=[...new Set(bindings.map(r=>Number(r.item_id)).filter(n=>n>0))];
  const rows=await db.query(select+`(m.article_id IN(${marks(ids)}) OR m.url IN(${marks(urls)})${physical.length?' OR m.item_id IN('+marks(physical)+')':''})`,[...ids,...urls,...physical]);
  for(const a of part){check();if(!legacyBookReadingArticle(a)||protectedIds.has(a.articleId)){remaining.push(a);continue;}
   let candidates=rows.filter(r=>r.article_id===a.articleId),predicate:Predicate={sql:'m.article_id=?',params:[a.articleId]};
   if(!candidates.length){candidates=rows.filter(r=>items.get(a.articleId)?.includes(Number(r.item_id)));predicate=native([a.articleId]);}
   if(!candidates.length){candidates=rows.filter(r=>r.url===a.url&&r.channel_url===a.rssSourceUrl);predicate={sql:'m.url=? AND m.channel_url=?',params:[a.url,a.rssSourceUrl!]};}
   if(!candidates.length){
    // Known historical identity functions only. Never infer a chapter from a
    // title, its array position or an unverified remote ordinal.
    try{canonicalRssUrl(a.url,false);}catch{remaining.push(a);continue;}
    const keys=[...new Set([await store.ports.sha256(utf8Encode(a.url)),await store.ports.stableId(a.url),await legacyWebArticleId(a.url,store.ports.sha256)])];
    const binding=native(keys);predicate={sql:`(m.article_id IN(${marks(keys)}) OR ${binding.sql}) AND m.channel_url=?`,params:[...keys,...binding.params,a.rssSourceUrl!]};
    candidates=await db.query(select+predicate.sql,predicate.params);
   }
   const targets=new Set(candidates.map(r=>str(r.book_id)+':'+Number(r.chapter_index))),r=candidates[0];
   if(targets.size!==1||!r||Number(r.chapter_index)<1||Number(r.chapter_index)>Number(r.chapter_count)){remaining.push(a);continue;}
   const bookId=str(r.book_id),chapterIndex=Number(r.chapter_index),readingIntent=!!(a.isRead||a.readingProgress||a.readingPositionChangedAt||a.readingPositionBytes),old=readingIntent?undefined:(await db.query('SELECT state_json FROM sync_book_reading WHERE book_id=? AND chapter_index=?',[bookId,chapterIndex]))[0];
   const basis:BookReading|undefined=old?JSON.parse(str(old.state_json)):undefined;
   const value:BookReading={bookId,chapterIndex,isRead:readingIntent?a.isRead:basis?.isRead??false,readingProgress:readingIntent?a.readingProgress:basis?.readingProgress??0,readingPositionBytes:readingIntent?a.readingPositionBytes:basis?.readingPositionBytes??0,readingPositionContentHash:readingIntent?a.readingPositionContentHash:basis?.readingPositionContentHash??'',readingPositionChangedAt:readingIntent?a.readingPositionChangedAt:basis?.readingPositionChangedAt??0,sourceDeviceId:readingIntent?a.sourceDeviceId:basis?.sourceDeviceId??a.sourceDeviceId};
   for(const p of ['favorite','watchLater'] as const)if(a[`${p}Saved`]||a[`${p}ChangedAt`]>0){value[`${p}Saved`]=a[`${p}Saved`];value[`${p}ChangedAt`]=a[`${p}ChangedAt`];value[`${p}SortOrder`]=a[`${p}SortOrder`];value[`${p}SourceDeviceId`]=a.sourceDeviceId;}
   readings.push(value);
   // Alias changes need their own predicate: not all alias columns advance the
   // global revision. Dirty native clocks must be captured before projection.
   const qualified=`FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE b.registration_complete=1 AND ${predicate.sql}`;
   guards.push({sql:`UPDATE sync_library_revision SET revision=CASE WHEN (SELECT count(DISTINCT m.book_id||':'||m.chapter_index) ${qualified})=1 AND EXISTS(SELECT 1 ${qualified} AND m.book_id=? AND m.chapter_index=?) AND NOT EXISTS(SELECT 1 FROM sync_book_reading_dirty d JOIN sync_book_aliases x ON x.item_id=d.item_id WHERE x.book_id=? AND x.chapter_index=?) THEN revision ELSE NULL END WHERE id=1`,params:[...predicate.params,...predicate.params,bookId,chapterIndex,bookId,chapterIndex]});
  }
  check();if(readings.length)changed+=await store.mergeReadingBatch(readings,{capture:false,expectedRevision:revision,guards});check();
 }
 return {changed,remaining};
}
