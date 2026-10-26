import {projectionGuard} from './domain-definitions';
import {jsonRecordTupleCodec} from '@podjs/framework/record-tuples';
import {articleMetadataHash} from './article-export';
import {sha256Hex} from '@podjs/framework/crypto';
import type {SqlDatabase,SqlParams} from '../core/types';
import type {PreparedArticle} from './article-export';
import {querySyncPages} from './sql-pages';
import {revisionGuard} from './revision';

export interface ProjectionRow {prepared:PreparedArticle;sourceItem:number}
export interface ProjectionPlan {generation:string;revision:number;seq:number;rows:ProjectionRow[];urls?:string[];bodyUrls?:string[];readingUrls?:string[]}
interface CachedProjection {article:PreparedArticle['article'];manifest:PreparedArticle['manifest'];encodedBody:null;syntheticBytes?:number[]}
function packedProjection(p:PreparedArticle,sourceItem:number):CachedProjection {
 const synthetic=!sourceItem&&p.manifest.bodyAvailable;
 if(synthetic&&(!p.encodedBody||p.encodedBody.length>256||p.article.contentHtml!==null||p.article.contentText!==''||p.article.independentSaved||p.article.favoriteSaved||p.article.watchLaterSaved))throw Error('Cannot cache a source-less nonempty body');
 return {article:{...p.article,contentHtml:null,contentText:''},manifest:p.manifest,encodedBody:null,...(synthetic?{syntheticBytes:[...p.encodedBody!]}:{})};
}
// The immutable full cache remains authoritative for materialization. The
// compact index contains only selection/identity fields and a complete manifest.
// v1 ordinals are append-only; the original full record remains readable.
const manifestTuple=jsonRecordTupleCodec(['articleId','sourceDeviceId','contentHash','updatedAt','independentChangedAt','favoriteChangedAt','watchLaterChangedAt','deletedAt','deleted','bodyHash','bodyByteCount','chunkSize','chunkHashes','metadataHash','bodyAvailable','bodySyncMode','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','isRead','legacyArticleIds']);
function lightProjection(p:PreparedArticle,sourceItem:number){const packed=packedProjection(p,sourceItem),a=p.article;return [1,a.url,a.rssSourceUrl,(a.independentSaved?1:0)|(a.favoriteSaved?2:0)|(a.watchLaterSaved?4:0),manifestTuple.encode(p.manifest as unknown as Record<string,unknown>),packed.syntheticBytes??null];}
function readLight(value:unknown):CachedProjection{
 if(!Array.isArray(value)||value.length!==6||value[0]!==1||typeof value[1]!=='string'||value[2]!==null&&typeof value[2]!=='string'||!Number.isInteger(value[3])||value[3]<0||value[3]>7)throw Error('Invalid light projection');
 const manifest=manifestTuple.decode(value[4]) as unknown as PreparedArticle['manifest'];
 return {article:{articleId:manifest.articleId,url:value[1],rssSourceUrl:value[2],independentSaved:!!(value[3]&1),favoriteSaved:!!(value[3]&2),watchLaterSaved:!!(value[3]&4),contentHtml:null,contentText:''} as PreparedArticle['article'],manifest,encodedBody:null,...(value[5]!==null?{syntheticBytes:value[5]}:{})};
}
let serial=0;
/** Derived data only. The source revision and a complete change witness must
 * agree; an unknown writer, schema change or a missing journal forces a rebuild.
 * No article body is copied into this cache. */
export class LibraryProjectionCache {
 private ready?:Promise<void>;
 private cookie=-1;
 private loaded=new Map<string,ProjectionRow[]>();
 private lazy=new WeakMap<PreparedArticle,{scope:string;generation:string;id:string;sourceItem:number}>();
 constructor(private readonly db:SqlDatabase,private readonly yieldTurn:()=>Promise<unknown>=()=>db.query('SELECT 1')){}
 async initialize(){if(this.ready)await this.ready;const cookie=Number(Object.values((await this.db.query('PRAGMA schema_version'))[0]!)[0]);if(cookie===this.cookie)return;this.ready=this.install().then(async()=>{this.loaded.clear();this.cookie=Number(Object.values((await this.db.query('PRAGMA schema_version'))[0]!)[0]);}).catch(e=>{this.ready=undefined;throw e;});await this.ready;}
 private async install(){
  await this.db.transaction([
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_header(scope TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL,seq INTEGER NOT NULL)'},
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_rows(scope TEXT NOT NULL,generation TEXT NOT NULL,article_id TEXT NOT NULL,url TEXT NOT NULL,position INTEGER NOT NULL,source_item INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(scope,generation,article_id))'},
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_url ON sync_projection_rows(scope,generation,url)'},
   // Cold pagination must stream index order, not repeatedly sort multi-MiB JSON.
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_order ON sync_projection_rows(scope,generation,position,article_id)'},
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_article_url ON articles(COALESCE(link,dedup_key))'},
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_link ON articles(link)'},
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_guid ON articles(guid)'},
   {sql:'CREATE INDEX IF NOT EXISTS sync_projection_dedup ON articles(dedup_key)'},
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_light(scope TEXT NOT NULL,generation TEXT NOT NULL,article_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(scope,generation,article_id),FOREIGN KEY(scope,generation,article_id) REFERENCES sync_projection_rows(scope,generation,article_id) ON DELETE CASCADE)'},
   {sql:'CREATE TRIGGER IF NOT EXISTS sync_projection_light_delete BEFORE DELETE ON sync_projection_rows BEGIN DELETE FROM sync_projection_light WHERE scope=OLD.scope AND generation=OLD.generation AND article_id=OLD.article_id;END'},
   {sql:"CREATE TRIGGER IF NOT EXISTS sync_projection_light_invalidate AFTER UPDATE ON sync_projection_rows WHEN OLD.json IS NOT NEW.json OR OLD.url IS NOT NEW.url OR OLD.source_item IS NOT NEW.source_item OR OLD.scope IS NOT NEW.scope OR OLD.generation IS NOT NEW.generation OR OLD.article_id IS NOT NEW.article_id BEGIN DELETE FROM sync_projection_light WHERE scope=OLD.scope AND generation=OLD.generation AND article_id=OLD.article_id;END"},
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,old_url TEXT,new_url TEXT)'},
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_totals(id INTEGER PRIMARY KEY CHECK(id=1),real_events INTEGER NOT NULL)'},
   {sql:'INSERT OR IGNORE INTO sync_projection_totals VALUES(1,0)'},
   {sql:"CREATE TRIGGER IF NOT EXISTS sync_projection_totals_capture AFTER INSERT ON sync_projection_events WHEN NEW.kind NOT IN ('cacheUrl','cacheNone') BEGIN UPDATE sync_projection_totals SET real_events=real_events+1 WHERE id=1;END"},
   {sql:'CREATE TABLE IF NOT EXISTS sync_projection_installation(id INTEGER PRIMARY KEY CHECK(id=1),definition TEXT NOT NULL)'},
  ]);
  const triggers=await this.db.query("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sync_projection_%' AND sql LIKE '%UPDATE sync_library_revision SET revision=revision+1%' ORDER BY name");
  const cacheLayouts=await Promise.all(['article_sync_content','article_sync_encoding_cache','article_native_sync_hash'].map(async table=>[table,await this.db.query('PRAGMA table_info('+table+')')]));
  const definition='r47-cache-v8:'+JSON.stringify([triggers,cacheLayouts]),old=(await this.db.query('SELECT definition FROM sync_projection_installation WHERE id=1'))[0];
  if(old?.definition===definition)return;
  const statements:{sql:string;params?:SqlParams}[]=[];
  for(const t of await this.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_projection_track_%'"))statements.push({sql:`DROP TRIGGER "${String(t.name).replaceAll('"','""')}"`});
  for(const t of triggers){
   const table=String(t.tbl_name),sql=String(t.sql),op=/ AFTER (INSERT|UPDATE|DELETE)\b/.exec(sql)?.[1];
   if(!op)throw Error('Unrecognized projection revision trigger');
   const url=(ref:string)=>{
    if(table==='articles')return `COALESCE(${ref}.link,${ref}.dedup_key)`;
    if(['channels','sync_source_states','sync_saved_states','sync_article_ids','sync_article_deletions','sync_article_keeps','sync_article_keep_aliases'].includes(table))return `${ref}.url`;
    if(table==='local_article_deletions')return `${ref}.article_url`;
    const column=table==='sync_article_aliases'?'item_id':table==='article_reading_state'||table.startsWith('article_')?'article_id':null;
    return column?`(SELECT COALESCE(link,dedup_key) FROM articles WHERE id=${ref}.${column})`:'NULL';
   };
   const full=['sync_local_identity','sync_books','sync_book_events'].includes(table),kind=table==='sync_book_reading'?'bookOnly':table==='sync_source_states'||table==='channels'&&op!=='DELETE'?'source':table==='channels'&&op==='DELETE'||full?'full':'url';
   const bodyTables=['article_body_chunks','article_original_chunks','article_previews','article_original_previews','article_original_meta'];
   const bodyChange=table==='articles'?(op==='UPDATE'?['content','description','link','guid','dedup_key'].map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR '):'1'):bodyTables.includes(table)?'1':'0';
   const eligible=(ref:string)=>{
    const item=table==='articles'?`${ref}.id`:table==='sync_article_ids'||table==='sync_article_aliases'||table==='sync_saved_states'?`${ref}.item_id`:table==='article_reading_state'||table.startsWith('article_')?`${ref}.article_id`:null;
    if(!item)return '1';
    const a=table==='articles'?ref:'a',local=`EXISTS(SELECT 1 FROM channels ch WHERE ch.id=${a}.channel_id AND (ch.url LIKE '%watchrss://phone-imports%' OR ch.url LIKE '%https://watchrss.local/import-content%' OR ch.url LIKE '%https://watchrss.local/import-epub%' OR ch.url LIKE '%https://watchrss.local/import-txt-novel%'))`;
    const test=`(${local} OR EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=${a}.id) OR EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=${a}.id) OR EXISTS(SELECT 1 FROM sync_projection_rows p JOIN sync_projection_header h ON p.scope=h.scope AND p.generation=h.generation WHERE p.url=COALESCE(${a}.link,${a}.dedup_key)))`;
    return table==='articles'?test:`EXISTS(SELECT 1 FROM articles a WHERE a.id=${item} AND ${test})`;
   };
   const book=(ref:string)=>{const item=table==='articles'?`${ref}.id`:table==='sync_article_ids'||table==='sync_article_aliases'||table==='sync_saved_states'?`${ref}.item_id`:table==='article_reading_state'||table.startsWith('article_')?`${ref}.article_id`:null;return item?`EXISTS(SELECT 1 FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE m.item_id=${item} AND b.registration_complete=1)`:'0';};
   const refs=op==='UPDATE'?['OLD','NEW']:[op==='DELETE'?'OLD':'NEW'];
   const kindSql=table==='channels'&&op==='UPDATE'?`CASE WHEN ${['url','title','description','image_url','created_at','sort_order','is_pinned'].map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR ')} THEN 'source' ELSE 'none' END`:kind==='url'?`CASE WHEN NOT (${refs.map(eligible).join(' OR ')}) THEN 'none' WHEN ${refs.map(book).join(' OR ')} THEN CASE WHEN ${bodyChange} THEN 'bookBodyUrl' ELSE 'bookUrl' END WHEN ${bodyChange} THEN 'bodyUrl' ELSE 'url' END`:`'${kind}'`;

   const body=`INSERT INTO sync_projection_events(kind,old_url,new_url) VALUES(${kindSql},${op==='INSERT'?'NULL':url('OLD')},${op==='DELETE'?'NULL':url('NEW')});`;
   const begin=sql.search(/\bBEGIN\b/);if(begin<0)throw Error('Unrecognized projection revision trigger');
   const prefix=sql.slice(0,begin).replace(' AFTER DELETE ', ' BEFORE DELETE ').replace(/^CREATE TRIGGER(?: IF NOT EXISTS)?\s+\S+/,`CREATE TRIGGER IF NOT EXISTS sync_projection_track_${String(t.name)}`);
   statements.push({sql:prefix+'BEGIN '+body+'END'});
  }
  // Identity/registration caches affect the projection but older schemas did
  // not include them in the source revision. Observe those changes as well.
  for(const [table,cols]of [['cloud_rss_article_ids',['item_id','article_id']],['sync_book_aliases',['book_id','chapter_index','article_id','item_id','url','channel_url','wire_identity']],['sync_books',['registration_complete']]] as const){
   for(const op of ['INSERT','UPDATE','DELETE']){
    if(table==='sync_books'&&op!=='UPDATE')continue;
    const condition=op==='UPDATE'?' WHEN '+cols.map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR '):'';
    const ref=op==='DELETE'?'OLD':'NEW';
    const relevant=table==='cloud_rss_article_ids'?`EXISTS(SELECT 1 FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id=${ref}.item_id AND (c.url LIKE '%watchrss.local/import-%' OR c.url='watchrss://phone-imports' OR EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id) OR EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=a.id) OR EXISTS(SELECT 1 FROM sync_projection_rows p JOIN sync_projection_header h ON p.scope=h.scope AND p.generation=h.generation WHERE p.url=COALESCE(a.link,a.dedup_key))))`:'1';
    statements.push({sql:`CREATE TRIGGER IF NOT EXISTS sync_projection_track_extra_${table}_${op.toLowerCase()} ${op==='DELETE'?'BEFORE':'AFTER'} ${op} ON ${table}${condition} BEGIN UPDATE sync_library_revision SET revision=revision+1 WHERE id=1;INSERT INTO sync_projection_events(kind) VALUES(CASE WHEN ${relevant} THEN 'full' ELSE 'none' END);END`});
   }
  }
  for(const [table,cols]of [['article_sync_content',['item_id','content_html','content_text','body_hash','body_bytes','chunk_size','chunk_hashes']],['article_sync_encoding_cache',['item_id','body_hash','content_hash','source_device_id','updated_at','imported_at','metadata_state','site_name','rss_source_title']],['article_native_sync_hash',['item_id','body_hash']]] as const){
   const currentColumns=(await this.db.query('PRAGMA table_info('+table+')')).map(r=>String(r.name));
   for(const op of ['INSERT','UPDATE','DELETE']){
    const ref=op==='DELETE'?'OLD':'NEW',condition=op==='UPDATE'?' WHEN '+currentColumns.map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR '):'';
    statements.push({sql:`CREATE TRIGGER IF NOT EXISTS sync_projection_track_cache_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}${condition} BEGIN INSERT INTO sync_projection_events(kind,new_url) SELECT CASE WHEN EXISTS(SELECT 1 FROM channels c WHERE c.id=articles.channel_id AND (c.url LIKE '%watchrss.local/import-%' OR c.url='watchrss://phone-imports')) OR EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=articles.id) OR EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=articles.id) OR EXISTS(SELECT 1 FROM sync_projection_rows p JOIN sync_projection_header h ON p.scope=h.scope AND p.generation=h.generation WHERE p.url=COALESCE(articles.link,articles.dedup_key)) THEN 'cacheUrl' ELSE 'cacheNone' END,COALESCE(link,dedup_key) FROM articles WHERE id=${ref}.item_id;END`});
   }
  }
  statements.push({sql:'DELETE FROM sync_projection_header'},{sql:'INSERT OR REPLACE INTO sync_projection_installation VALUES(1,?)',params:[definition]});
  await this.db.transaction(statements);
 }
 async sequence(){await this.initialize();return Number((await this.db.query("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_projection_events'),0) AS seq"))[0]!.seq);}
 async plan(scope:string,revision:number,bookMode:boolean):Promise<ProjectionPlan|undefined>{
  await this.initialize();const h=(await this.db.query('SELECT * FROM sync_projection_header WHERE scope=?',[scope]))[0];if(!h)return;
  const events=await querySyncPages(this.db,'SELECT seq,kind,old_url,new_url FROM sync_projection_events WHERE seq>? ORDER BY seq',[Number(h.seq)]);
  const seq=await this.sequence();if(seq-Number(h.seq)!==events.length)return;
  if(revision<Number(h.revision)||revision-Number(h.revision)!==events.filter(r=>!['cacheUrl','cacheNone'].includes(String(r.kind))).length||events.some(r=>r.kind==='full'||r.kind==='bookOnly'&&!bookMode||['url','bodyUrl','cacheUrl','bookUrl','bookBodyUrl'].includes(String(r.kind))&&!r.old_url&&!r.new_url))return;
  const urls=[...new Set(events.flatMap(r=>(['url','bodyUrl','cacheUrl'].includes(String(r.kind))||!bookMode&&['bookUrl','bookBodyUrl'].includes(String(r.kind)))?[r.old_url,r.new_url].filter(v=>typeof v==='string'&&v.length>0) as string[]:[]))];
  let rows=this.loaded.get(scope+'\0'+[h.generation,h.revision,h.seq].join(':'));
  if(!rows){rows=[];
  const backfill:{sql:string;params:SqlParams}[]=[];
  for(const r of await querySyncPages(this.db,'SELECT p.article_id,p.source_item,l.json AS light_json,CASE WHEN l.json IS NULL THEN p.json ELSE NULL END AS full_json FROM sync_projection_rows p LEFT JOIN sync_projection_light l ON l.scope=p.scope AND l.generation=p.generation AND l.article_id=p.article_id WHERE p.scope=? AND p.generation=? ORDER BY p.position,p.article_id',[scope,String(h.generation)],400)){
   try{let light=r.light_json!=null,p:CachedProjection;
    try{p=light?readLight(JSON.parse(String(r.light_json))):JSON.parse(String(r.full_json));}
    catch{if(!light)throw Error('Invalid full projection');const full=(await this.db.query('SELECT json FROM sync_projection_rows WHERE scope=? AND generation=? AND article_id=?',[scope,String(h.generation),r.article_id]))[0];if(!full)return;p=JSON.parse(String(full.json));light=false;}
    if(!p.article?.articleId||p.article.articleId!==String(r.article_id)||p.manifest?.articleId!==p.article.articleId||p.encodedBody!==null)return;
    let encodedBody:Uint8Array|null=null;
    if(!Number(r.source_item)&&p.manifest.bodyAvailable){const bytes=p.syntheticBytes;if(!Array.isArray(bytes)||bytes.length<1||bytes.length>256||bytes.some(b=>!Number.isInteger(b)||b<0||b>255))return;encodedBody=Uint8Array.from(bytes);const hash=sha256Hex(encodedBody);if(p.article.contentText!==''||p.article.contentHtml!==null||p.article.independentSaved||p.article.favoriteSaved||p.article.watchLaterSaved||hash!==p.manifest.bodyHash||p.manifest.bodyByteCount!==bytes.length||p.manifest.chunkHashes.length!==1||p.manifest.chunkHashes[0]!==hash)return;}
    const prepared={article:p.article,manifest:p.manifest,encodedBody},sourceItem=Number(r.source_item);
    if(light)this.lazy.set(prepared,{scope,generation:String(h.generation),id:p.article.articleId,sourceItem});
    else backfill.push({sql:'INSERT OR REPLACE INTO sync_projection_light(scope,generation,article_id,json) SELECT scope,generation,article_id,? FROM sync_projection_rows WHERE scope=? AND generation=? AND article_id=?',params:[JSON.stringify(lightProjection(prepared,sourceItem)),scope,String(h.generation),p.article.articleId]});
    rows.push({prepared,sourceItem});if(rows.length%32===0)await this.yieldTurn();
   }catch{return;}
  }
  // Existing full caches remain readable; only disposable local metadata is
  // backfilled, with the same revision guard used by normal publication.
  for(let at=0;at<backfill.length;at+=200)await this.db.transaction([revisionGuard(revision),...backfill.slice(at,at+200)]);
  for(const key of this.loaded.keys())if(key.startsWith(scope+'\0'))this.loaded.delete(key);this.loaded.set(scope+'\0'+[h.generation,h.revision,h.seq].join(':'),rows);}
  const sources=new Set(events.filter(r=>r.kind==='source').flatMap(r=>[r.old_url,r.new_url].filter(v=>typeof v==='string') as string[]));
  for(const r of rows)if(r.prepared.article.rssSourceUrl&&sources.has(r.prepared.article.rssSourceUrl)&&!urls.includes(r.prepared.article.url))urls.push(r.prepared.article.url);
  if(urls.length>64)return;
  return {generation:String(h.generation),revision:Number(h.revision),seq,rows,...(events.length?{urls,readingUrls:[...new Set(events.filter(r=>!['cacheUrl','cacheNone','source','none'].includes(String(r.kind))&&(!bookMode||!['bookUrl','bookBodyUrl'].includes(String(r.kind)))).flatMap(r=>[r.old_url,r.new_url].filter(v=>typeof v==='string'&&v.length>0) as string[]))],bodyUrls:[...new Set(events.filter(r=>r.kind==='bodyUrl'||r.kind==='cacheUrl'||!bookMode&&r.kind==='bookBodyUrl').flatMap(r=>[r.old_url,r.new_url].filter(v=>typeof v==='string'&&v.length>0) as string[]))]}:{})};
 }
 async full(prepared:readonly PreparedArticle[]):Promise<PreparedArticle[]>{
  const groups=new Map<string,{p:PreparedArticle;ref:{scope:string;generation:string;id:string;sourceItem:number}}[]>();
  for(const p of prepared){const ref=this.lazy.get(p);if(!ref)continue;const key=JSON.stringify([ref.scope,ref.generation]),group=groups.get(key)??[];group.push({p,ref});groups.set(key,group);}
  for(const group of groups.values())for(let at=0;at<group.length;at+=32){const page=group.slice(at,at+32),ref=page[0]!.ref;
   const rows=await querySyncPages(this.db,'SELECT article_id,json,source_item FROM sync_projection_rows WHERE scope=? AND generation=? AND article_id IN ('+page.map(()=>'?').join(',')+')',[ref.scope,ref.generation,...page.map(r=>r.ref.id)],32),byId=new Map(rows.map(r=>[String(r.article_id),r]));
   for(const {p,ref}of page){const row=byId.get(ref.id);if(!row)throw Error('Projection metadata disappeared');const full=JSON.parse(String(row.json)) as CachedProjection;
    if(!full.article||full.article.articleId!==ref.id||full.article.url!==p.article.url||Number(row.source_item)!==ref.sourceItem||JSON.stringify(full.manifest)!==JSON.stringify(p.manifest)||await articleMetadataHash(full.article,{sha256:async bytes=>sha256Hex(bytes)})!==p.manifest.metadataHash)throw Error('Projection metadata changed');
    p.article=full.article;this.lazy.delete(p);
   }
  }return [...prepared];
 }
 async publish(scope:string,revision:number,articles:readonly PreparedArticle[],bindings:ReadonlyMap<string,number>,previous?:ProjectionPlan,urls?:readonly string[],observedSeq?:number,definitionGeneration?:string){
  await this.initialize();const guards=definitionGeneration?[projectionGuard(definitionGeneration)]:[];let generation=Date.now().toString(36)+'-'+(++serial);const seq=observedSeq??await this.sequence();
  const dirty=urls?new Set(urls):undefined,write=dirty?articles.filter(p=>dirty.has(p.article.url)):articles;
  const positionBase=previous&&urls?Number((await this.db.query('SELECT COALESCE(MAX(position),-1)+1 AS next FROM sync_projection_rows WHERE scope=? AND generation=?',[scope,previous.generation]))[0]!.next):0;
  const rowStatements=(p:PreparedArticle,i:number)=>[{sql:'INSERT INTO sync_projection_rows(scope,generation,article_id,url,position,source_item,json) VALUES(?,?,?,?,?,?,?)',params:[scope,generation,p.article.articleId,p.article.url,positionBase+i,bindings.get(p.article.articleId)??0,JSON.stringify(packedProjection(p,bindings.get(p.article.articleId)??0))]},{sql:'INSERT INTO sync_projection_light VALUES(?,?,?,?)',params:[scope,generation,p.article.articleId,JSON.stringify(lightProjection(p,bindings.get(p.article.articleId)??0))]}];
  // Small edits update just their URLs in one atomic transaction. Readers key
  // decoded rows by the header's revision AND witness sequence; a stable
  // generation cannot make another repository reuse an older decoded array.
  const incremental=!!previous&&!!urls&&write.length<=900;
  if(incremental){
   generation=previous!.generation;
   await this.db.transaction([...guards,revisionGuard(revision),...(urls!.length?[{sql:'DELETE FROM sync_projection_rows WHERE scope=? AND generation=? AND url IN ('+urls!.map(()=>'?').join(',')+')',params:[scope,generation,...urls!]}]:[]),...write.flatMap(rowStatements),{sql:'INSERT OR REPLACE INTO sync_projection_header VALUES(?,?,?,?)',params:[scope,generation,revision,seq]}]);
  }else{
  if(previous&&urls){const clause=urls.length?' AND url NOT IN ('+urls.map(()=>'?').join(',')+')':'';await this.db.transaction([...guards,revisionGuard(revision),{sql:'INSERT INTO sync_projection_rows(scope,generation,article_id,url,position,source_item,json) SELECT scope,?,article_id,url,position,source_item,json FROM sync_projection_rows WHERE scope=? AND generation=?'+clause,params:[generation,scope,previous.generation,...urls]},{sql:'INSERT INTO sync_projection_light SELECT l.scope,?,l.article_id,l.json FROM sync_projection_light l JOIN sync_projection_rows p ON p.scope=l.scope AND p.generation=? AND p.article_id=l.article_id WHERE l.scope=? AND l.generation=?',params:[generation,generation,scope,previous.generation]}]);}
  for(let at=0;at<write.length;at+=100){
   await this.db.transaction([...guards,revisionGuard(revision),...write.slice(at,at+100).flatMap((p,i)=>rowStatements(p,at+i))]);
  }
  await this.db.transaction([...guards,revisionGuard(revision),{sql:'INSERT OR REPLACE INTO sync_projection_header VALUES(?,?,?,?)',params:[scope,generation,revision,seq]},{sql:'DELETE FROM sync_projection_rows WHERE scope=? AND generation!=?',params:[scope,generation]}]);
  }
  await this.db.transaction([...guards,{sql:'DELETE FROM sync_projection_rows WHERE scope IN (SELECT scope FROM sync_projection_header WHERE seq<?)',params:[Math.max(0,seq-8192)]},{sql:'DELETE FROM sync_projection_header WHERE seq<?',params:[Math.max(0,seq-8192)]},{sql:'DELETE FROM sync_projection_events WHERE seq<=(SELECT MIN(seq) FROM sync_projection_header)'}]);
  for(const key of this.loaded.keys())if(key.startsWith(scope+'\0'))this.loaded.delete(key);
  this.loaded.set(scope+'\0'+[generation,revision,seq].join(':'),articles.map(p=>{const ref=this.lazy.get(p);if(ref)this.lazy.set(p,{...ref,scope,generation});return {prepared:(ref||!bindings.get(p.article.articleId)&&p.encodedBody?p:{article:{...p.article,contentHtml:null,contentText:''},manifest:p.manifest,encodedBody:null}),sourceItem:bindings.get(p.article.articleId)??0};}));
 }
}
