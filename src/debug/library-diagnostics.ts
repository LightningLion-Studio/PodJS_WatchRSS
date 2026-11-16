import {isImportedTextItemUrl} from '../core/imported-content';
import {isBookUrl} from '../books/package';
import type {SqlDatabase} from '../core/types';
import type {BookFiles} from '../books/files';
import {querySyncPages} from '../sync/sql-pages';
import {bookFields,summaryFields,opaqueId} from './sync-diagnostics';
/** SELECT/file reads only. Do not call registerLocal, manifests or UI repair paths. */
export class LibraryDiagnostics {
 constructor(private db:Pick<SqlDatabase,'query'>,private files:Pick<BookFiles,'hash'>,private readable:(itemId:number)=>Promise<boolean>,private rejections:ReadonlyMap<string,string>=new Map()){}
 private async pending(check:()=>void=()=>{}){
  check();
  const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  if(!['articles','channels','sync_book_aliases'].every(t=>tables.has(t)))return [];
  const rows=await querySyncPages(this.db,`SELECT a.id,a.link,a.title,c.url channel_url,c.title channel_title FROM articles a JOIN channels c ON c.id=a.channel_id WHERE (a.link LIKE 'https://watchrss.local/import-%' OR a.link LIKE 'watchrss://import/%') AND NOT EXISTS(SELECT 1 FROM sync_book_aliases m WHERE m.item_id=a.id) ORDER BY c.id,a.id`);
  const groups=new Map<string,typeof rows>();
  for(const r of rows){check();if(!isBookUrl(String(r.link)))continue;const key=isImportedTextItemUrl(String(r.link))?String(r.link):String(r.channel_url);const group=groups.get(key)??[];group.push(r);groups.set(key,group);}
  const result=[];for(const rows of groups.values()){check();const first=rows[0]!;result.push(bookFields({bookId:null,title:isImportedTextItemUrl(String(first.link))?first.title:first.channel_title,chapterCount:rows.length,packageBytes:0,packageSha256:null,status:'staged',reasonCode:'registration_pending',readable:await this.readable(Number(first.id)).catch(()=>false)}));}
  return result;
 }
 async books(check:()=>void=()=>{}){
  check();
  const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  if(!tables.has('sync_books'))return this.pending(check);
  const rows=await querySyncPages(this.db,'SELECT book_id,state_json,chapter_count,package_path,package_sha256,package_bytes,registration_complete FROM sync_books ORDER BY book_id');
  const result=[];
  for(const r of rows){
   check();   let state:Record<string,unknown>={};try{const parsed=JSON.parse(String(r.state_json));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))state=parsed;}catch{}
   if(state.deleted===true)continue;
   let status='staged',reason='package_missing',readable=false;
   try{
    if(!r.package_path||!r.package_sha256){status='staged';}
    else {const hash=await this.files.hash(String(r.package_path));check();if(hash.sha256!==r.package_sha256||hash.size!==Number(r.package_bytes)){status='failed';reason='package_hash_mismatch';}else if(!Number(r.registration_complete)){status='staged';reason='staged';}else{status='ready';reason='none';}}
    const first=(await this.db.query('SELECT item_id FROM sync_book_chapters WHERE book_id=? AND chapter_index=1',[r.book_id]))[0];
    readable=first?.item_id!=null&&await this.readable(Number(first.item_id));
    if(status==='ready'&&!readable){status='failed';reason='body_missing';}
   }catch{check();status='failed';reason='read_failed';}
   if(status==='staged'&&this.rejections.has(String(r.book_id))){status='failed';reason=this.rejections.get(String(r.book_id))!;}
   if(typeof state.title!=='string'||!opaqueId(r.book_id)){status='failed';reason='metadata_invalid';}
   result.push(bookFields({bookId:r.book_id,title:state.title,chapterCount:Number(r.chapter_count),packageBytes:Number(r.package_bytes),packageSha256:r.package_sha256,status,reasonCode:reason,readable}));
  }
  return [...result,...await this.pending(check)];
 }
 async summary(check:()=>void=()=>{}){
  check();
  const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  const n=async(table:string,sql:string)=>tables.has(table)?Number((await this.db.query(sql))[0]?.n??0):0;
  return summaryFields({channels:await n('channels','SELECT count(*) n FROM channels'),articles:await n('articles','SELECT count(*) n FROM articles a JOIN channels c ON c.id=a.channel_id'),favorites:await n('article_saved_states',"SELECT count(*) n FROM article_saved_states s JOIN articles a ON a.id=s.article_id JOIN channels c ON c.id=a.channel_id WHERE s.save_type='favorite' AND s.saved=1"),watchLater:await n('article_saved_states',"SELECT count(*) n FROM article_saved_states s JOIN articles a ON a.id=s.article_id JOIN channels c ON c.id=a.channel_id WHERE s.save_type='watchLater' AND s.saved=1"),memos:await n('memo_notes','SELECT count(*) n FROM memo_notes WHERE deleted=0'),books:tables.has('sync_book_aliases')?await n('sync_books',"SELECT count(DISTINCT b.book_id) n FROM sync_books b JOIN sync_book_aliases m ON m.book_id=b.book_id JOIN articles a ON a.id=m.item_id JOIN channels c ON c.id=a.channel_id WHERE CASE WHEN json_valid(b.state_json) THEN COALESCE(json_extract(b.state_json,'$.deleted'),0)=0 ELSE 1 END")+(await this.pending(check)).length:(await this.pending(check)).length});
 }
}
