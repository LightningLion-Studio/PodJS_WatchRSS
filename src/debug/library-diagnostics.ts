import type {SqlDatabase} from '../core/types';
import type {BookFiles} from '../books/files';
import {bookFields,summaryFields,opaqueId,type BookPage} from './sync-diagnostics';
// Group in SQLite; no chapter text, URLs, full state JSON or per-library maps cross the bridge.
const single=`(lower(a.link) LIKE 'https://watchrss.local/import-content/txt/%' OR (lower(a.link) GLOB 'watchrss://import/online-v1/*' AND length(a.link)=92 AND substr(lower(a.link),29) NOT GLOB '*[^a-f0-9]*') OR (a.link GLOB 'watchrss://import/instance-v1/*' AND substr(a.link,31,32) NOT GLOB '*[^a-f0-9]*' AND length(substr(a.link,31,32))=32 AND (length(a.link)=62 OR substr(a.link,63,1)='/')))`;
const imported=`(lower(a.link) LIKE 'https://watchrss.local/import-txt-novel/%' OR lower(a.link)='https://watchrss.local/import-txt-novel' OR lower(a.link) LIKE 'https://watchrss.local/import-epub/%' OR lower(a.link)='https://watchrss.local/import-epub' OR ${single})`;
const groups=`SELECT min(a.id) first_id,min(c.id) channel_id,count(*) chapter_count FROM articles a JOIN channels c ON c.id=a.channel_id WHERE ${imported} AND NOT EXISTS(SELECT 1 FROM sync_book_aliases m WHERE m.item_id=a.id) GROUP BY CASE WHEN ${single} THEN a.link ELSE c.url END`;
const live=`CASE WHEN json_valid(state_json) THEN COALESCE(json_extract(state_json,'$.deleted'),0)<>1 ELSE 1 END`;
/** SELECT/file reads only. Every bridge result is bounded independently of library size. */
export class LibraryDiagnostics {
 constructor(private db:Pick<SqlDatabase,'query'>,private files:Pick<BookFiles,'hash'>,private readable:(itemId:number)=>Promise<boolean>,private rejections:ReadonlyMap<string,string>=new Map()){}
 private async tables(check:()=>void){check();return new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('articles','channels','sync_book_aliases','sync_books','memo_notes','article_saved_states')")).map(r=>String(r.name)));}
 private async pending(tables:Set<string>,check:()=>void,page:BookPage){
  if(!['articles','channels','sync_book_aliases'].every(t=>tables.has(t)))return [];
  check();const rows=await this.db.query(`SELECT g.first_id,g.chapter_count,substr(CASE WHEN ${single} THEN a.title ELSE c.title END,1,512) title FROM (${groups}) g JOIN articles a ON a.id=g.first_id JOIN channels c ON c.id=a.channel_id ORDER BY g.channel_id,g.first_id LIMIT ? OFFSET ?`,[page.limit,page.offset]);
  const result=[];for(const row of rows){check();const readable=await this.readable(Number(row.first_id)).catch(()=>false);check();result.push(bookFields({bookId:null,title:row.title,chapterCount:Number(row.chapter_count),status:'staged',reasonCode:'registration_pending',readable}));}return result;
 }
 async books(check:()=>void=()=>{},page:BookPage={offset:0,limit:12}){
  if(!Number.isSafeInteger(page.offset)||page.offset<0||!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>13)throw Error('invalid_argument');
  const tables=await this.tables(check);const result=[];let registered=0;
  if(tables.has('sync_books')){
   check();registered=Number((await this.db.query(`SELECT count(*) n FROM sync_books WHERE ${live}`))[0]?.n??0);
   check();const rows=await this.db.query(`SELECT book_id,CASE WHEN json_valid(state_json) THEN substr(json_extract(state_json,'$.title'),1,512) END title,CASE WHEN json_valid(state_json) THEN json_type(state_json,'$.title') END title_type,chapter_count,package_path,package_sha256,package_bytes,registration_complete FROM sync_books WHERE ${live} ORDER BY book_id LIMIT ? OFFSET ?`,[page.limit,page.offset]);
   for(const r of rows){
    check();let status='staged',reason='package_missing',readable=false;
    try{
     if(r.package_path&&r.package_sha256){const hash=await this.files.hash(String(r.package_path));check();if(hash.sha256!==r.package_sha256||hash.size!==Number(r.package_bytes)){status='failed';reason='package_hash_mismatch';}else if(!Number(r.registration_complete)){reason='staged';}else{status='ready';reason='none';}}
     check();const first=(await this.db.query('SELECT item_id FROM sync_book_chapters WHERE book_id=? AND chapter_index=1 LIMIT 1',[r.book_id]))[0];
     readable=first?.item_id!=null&&await this.readable(Number(first.item_id));check();
     if(status==='ready'&&!readable){status='failed';reason='body_missing';}
    }catch{check();status='failed';reason='read_failed';}
    const prefix=String(r.book_id).slice(0,8);
    if(status==='staged'&&this.rejections.has(prefix)){check();const matches=Number((await this.db.query('SELECT count(*) n FROM sync_books WHERE substr(book_id,1,8)=?',[prefix]))[0]?.n??0);if(matches===1){status='failed';reason=this.rejections.get(prefix)!;}}
    if(r.title_type!=='text'||!opaqueId(r.book_id)){status='failed';reason='metadata_invalid';}
    result.push(bookFields({bookId:r.book_id,title:r.title,chapterCount:Number(r.chapter_count),packageBytes:Number(r.package_bytes),packageSha256:r.package_sha256,status,reasonCode:reason,readable}));
   }
  }
  if(result.length>=page.limit)return result;
  return [...result,...await this.pending(tables,check,{offset:Math.max(0,page.offset-registered),limit:page.limit-result.length})];
 }
 async summary(check:()=>void=()=>{}){
  const tables=await this.tables(check);const n=async(table:string,sql:string)=>{check();const result=tables.has(table)?Number((await this.db.query(sql))[0]?.n??0):0;check();return result;};
  const pending=['articles','channels','sync_book_aliases'].every(t=>tables.has(t))?await n('articles',`SELECT count(*) n FROM (${groups})`):0;
  return summaryFields({channels:await n('channels','SELECT count(*) n FROM channels'),articles:await n('articles','SELECT count(*) n FROM articles a JOIN channels c ON c.id=a.channel_id'),favorites:await n('article_saved_states',"SELECT count(*) n FROM article_saved_states s JOIN articles a ON a.id=s.article_id JOIN channels c ON c.id=a.channel_id WHERE s.save_type='favorite' AND s.saved=1"),watchLater:await n('article_saved_states',"SELECT count(*) n FROM article_saved_states s JOIN articles a ON a.id=s.article_id JOIN channels c ON c.id=a.channel_id WHERE s.save_type='watchLater' AND s.saved=1"),memos:await n('memo_notes','SELECT count(*) n FROM memo_notes WHERE deleted=0'),books:pending+(tables.has('sync_book_aliases')?await n('sync_books',"SELECT count(DISTINCT b.book_id) n FROM sync_books b JOIN sync_book_aliases m ON m.book_id=b.book_id JOIN articles a ON a.id=m.item_id JOIN channels c ON c.id=a.channel_id WHERE CASE WHEN json_valid(b.state_json) THEN COALESCE(json_extract(b.state_json,'$.deleted'),0)<>1 ELSE 1 END"):0)});
 }
}
