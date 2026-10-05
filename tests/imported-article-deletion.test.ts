import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,writeFile,readdir,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {initializeSchema} from '../src/core/schema.ts';
import type {SqlDatabase} from '../src/core/types.ts';
import {ImportedArticleDeletion} from '../src/core/imported-article-deletion.ts';
import {isDeletableLocalContentChannel} from '../src/core/imported-content.ts';
import {LocalArticleManifestStore,type SyncTextPort} from '../src/sync/local-manifest.ts';
import {SqlLibrarySequenceStore} from '../src/sync/sequence-store.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../src/sync/article-body.ts';
const codec:SyncBodyCodec={sha256:async b=>new Bun.CryptoHasher('sha256').update(b).digest('hex'),encode:async b=>gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString('utf8')};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async value=>value};
async function fixture(channel='watchrss://phone-imports'){
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db);await db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");
 await db.execute('INSERT INTO channels(id,url,title,created_at) VALUES(1,?,?,1)',[channel,'Import']);
 await db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_saved) VALUES(1,1,'A','watchrss-watch-content:body.txt','https://example.com/a','a',1,1)");
 for(const type of ['favorite','watchLater'])await db.execute('INSERT INTO article_saved_states VALUES(1,?,1,1,-1)',[type]);
 for(const table of ['article_body_chunks','article_original_chunks'])await db.execute(`INSERT INTO ${table} VALUES(1,0,'chunk')`);
 await db.execute("INSERT INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) VALUES(1,'IMAGE','https://image','offline/rss/1/image.png',1)");
 const root=await mkdtemp(join(tmpdir(),'wrss-delete-'));await mkdir(join(root,'article_content'));await mkdir(join(root,'offline/rss/1'),{recursive:true});
 await writeFile(join(root,'article_content/body.txt'),'body');await writeFile(join(root,'offline/rss/1/image.png'),'image');
 let fail=false,silent=false;
 const files={stat:async(path:string)=>({exists:await stat(join(root,path)).then(()=>true,()=>false)}),list:async(path:string)=>({entries:(await readdir(join(root,path),{withFileTypes:true})).map(e=>({path:path+'/'+e.name,file:e.isFile(),directory:e.isDirectory()}))}),remove:async(path:string)=>{if(fail)throw new Error('disk failure');if(silent)return;await rm(join(root,path),{force:true});}};
 const action=new ImportedArticleDeletion(db,text,codec,files,async()=>{},()=>500);
 return {db,sql,root,action,fail:(value:boolean)=>{fail=value;},silent:(value:boolean)=>{silent=value;},close:async()=>{sql.close();await rm(root,{recursive:true,force:true});}};
}
test('delete entry follows channel identity including native trim, case and prefix rules',()=>{
 for(const url of ['watchrss://phone-imports','https://watchrss.local/import-content','https://watchrss.local/import-content/txt/a','https://watchrss.local/import-epub/book','https://watchrss.local/import-txt-novel/book',' HTTPS://WATCHRSS.LOCAL/IMPORT-EPUB/book '])expect(isDeletableLocalContentChannel(url)).toBe(true);
 for(const url of [null,undefined,'','https://feed.example/rss','builtin:bili','https://example.com/?url=https://watchrss.local/import-content'])expect(isDeletableLocalContentChannel(url)).toBe(false);
});
test('single deletion removes body/chunks/media, exports tombstones in full and delta sync, and is idempotent',async()=>{
 const f=await fixture();try{
  await f.action.delete(1);
  for(const table of ['articles','article_body_chunks','article_original_chunks','offline_media','article_saved_states','article_deletion_cleanup'])expect(await f.db.query(`SELECT * FROM ${table}`)).toEqual([]);
  expect(await readdir(join(f.root,'article_content'))).toEqual([]);expect(await readdir(join(f.root,'offline/rss/1'))).toEqual([]);
  expect(await f.db.query('SELECT saved,changed_at,item_id FROM sync_saved_states')).toEqual([{saved:0,changed_at:500,item_id:null},{saved:0,changed_at:500,item_id:null}]);
  const store=new LocalArticleManifestStore(f.db,codec,text,{storeText:async()=>{throw Error('unexpected body write');},hydrate:async v=>v},async()=>{});
  const snapshot=await store.snapshot(),manifests=snapshot.map(p=>p.manifest);
  expect(snapshot[0]!.article).toMatchObject({deleted:true,favoriteSaved:false,watchLaterSaved:false});
  expect(manifests).toHaveLength(1);expect(manifests[0]).toMatchObject({deleted:true,deletedAt:500,favoriteChangedAt:500,watchLaterChangedAt:500});
  const sequence=new SqlLibrarySequenceStore(f.db,()=>600);
  const full=await sequence.prepareWindow('phone','watch',manifests,async()=>[]);expect(full.fullSnapshot).toBe(true);expect(full.articleManifest).toEqual(manifests);
  await f.db.execute("INSERT INTO sync_peer_state VALUES('phone',0,0,550,14,550)");
  const delta=await sequence.prepareWindow('phone','watch',manifests,async()=>[]);expect(delta.fullSnapshot).toBe(false);expect(delta.articleManifest).toEqual(manifests);expect(delta.toSeqInclusive).toBe(1);
  await f.action.delete(1);expect(await f.db.query('SELECT reason,changed_at FROM sync_change_log')).toEqual([{reason:'delete',changed_at:500}]);
 }finally{await f.close();}
});
test('ordinary RSS is protected by the service deletion rule even with imported-looking item URLs',async()=>{
 const f=await fixture('https://feed.example/rss');try{await f.db.execute("UPDATE articles SET link='https://watchrss.local/import-content/txt/a'");await f.action.delete(1);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual([]);expect(await readdir(join(f.root,'article_content'))).toEqual(['body.txt']);}finally{await f.close();}
});
test('failed cleanup retains durable work and repeated deletion retries without another sequence',async()=>{
 const f=await fixture();try{f.fail(true);await expect(f.action.delete(1)).rejects.toThrow('disk failure');expect(await f.db.query('SELECT item_id FROM article_deletion_cleanup')).toEqual([{item_id:1}]);f.fail(false);await f.action.delete(1);expect(await f.db.query('SELECT * FROM article_deletion_cleanup')).toEqual([]);expect(await readdir(join(f.root,'article_content'))).toEqual([]);expect(await f.db.query('SELECT seq FROM sync_change_log')).toEqual([{seq:1}]);}finally{await f.close();}
});
test('shared imported body remains available to another article',async()=>{
 const f=await fixture();try{await f.db.execute("INSERT INTO articles(id,channel_id,title,content,dedup_key,fetched_at) VALUES(2,1,'B','watchrss-watch-content:body.txt','b',1)");await f.action.delete(1);expect(await readdir(join(f.root,'article_content'))).toEqual(['body.txt']);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:2}]);}finally{await f.close();}
});

test('silent host delete failure is verified and startup cleanup drains the pending work',async()=>{
 const f=await fixture();try{f.silent(true);await expect(f.action.delete(1)).rejects.toThrow('删除文件失败');f.silent(false);await f.action.cleanupPending();expect(await f.db.query('SELECT * FROM article_deletion_cleanup')).toEqual([]);expect(await readdir(join(f.root,'article_content'))).toEqual([]);expect(await f.db.query('SELECT seq FROM sync_change_log')).toEqual([{seq:1}]);}finally{await f.close();}
});
