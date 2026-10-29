import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,readdir,unlink,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {initializeSchema} from '../../src/core/schema';
import {MemoRepository} from '../../src/notes';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {clearPrivateContentFiles,type PrivateLibraryFiles} from '../../src/core/clear-private-files';
import {LibraryClearOperation} from '../../src/core/library-clear';
import {WatchAccountStore} from '../../src/account/store';
import {replacePairingAccount,type PairingReleaseTarget} from '../../src/account/pairing-release';
import type {SqlDatabase} from '../../src/core/types';
import vectors from '../cloud/fixtures/pairing-ux-v1.json';
const timer=(ms:number)=>{let id:ReturnType<typeof setTimeout>;return{result:new Promise<void>(r=>{id=setTimeout(r,ms);}),cancel:()=>clearTimeout(id!)}};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'pairing-replacement-')),path=join(root,'library.db');let sql=new Database(path),afterDelete=()=>{};
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...s.params??[] as any);})()};
 sql.exec('PRAGMA foreign_keys=ON');await initializeSchema(db);await new MemoRepository(db,'fixture').initialize();
 await db.execute("INSERT INTO sync_local_identity VALUES(1,?,'stable')",[vectors.context.deviceId]);
 await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1)");
 await db.execute("INSERT INTO articles(id,channel_id,title,content,dedup_key,fetched_at) VALUES(1,1,'private','watchrss-watch-content:body.txt','guid:one',1)");
 await db.execute("INSERT INTO article_reading_state VALUES(1,.5,10,123,'hash','{}')");
 await db.execute("INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,package_path) VALUES('book','f',1,'{}','books/book.jsonl')");
 const put=async(p:string,body:string|Uint8Array)=>{await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),body);};
 for(const p of ['books/book.jsonl','books/orphan.part','notes/assets/note.bin','sync_body/body.gz','watch-cloud-cache/piece'])await put(p,'private');await put('article_content/body.txt',new Uint8Array(4*1024*1024).fill(88));await put('reader_assets/fonts/keep.ttf','configuration');
 const files:PrivateLibraryFiles={list:async p=>({entries:(await readdir(join(root,p),{withFileTypes:true}).catch((e:any)=>{if(e.code==='ENOENT')return[];throw e;})).map(e=>({path:p+'/'+e.name,directory:e.isDirectory(),file:e.isFile()}))}),remove:async p=>{await unlink(join(root,p));afterDelete();},stat:async p=>({exists:await stat(join(root,p)).then(()=>true,(e:any)=>{if(e.code==='ENOENT')return false;throw e;})})};
 const repository=()=>new SqlLibrarySessionRepository(db,{codec:{} as never,text:{} as never,uri:{} as never,files:{} as never,migrateReading:async()=>{},cleanupRemovedContent:async()=>{throw Error('must use complete private namespace sweep');},clearContentFiles:(_private,control)=>clearPrivateContentFiles(files,{check:()=>control?.check(),onDeleted:n=>control?.progress('files',n)})});
 const values=new Map<string,string>([['watchrss.library.owner','old-owner']]),store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);}});
 return{db,files,store,values,repository,setAfterDelete:(f:()=>void)=>{afterDelete=f;},reopen:()=>{sql.close();sql=new Database(path);sql.exec('PRAGMA foreign_keys=ON');},close:async()=>{sql.close();await rm(root,{recursive:true,force:true});}};
}
for(const cancel of [false,true])test('pairing replacement clears actual SQLite+large body/book/note files'+(cancel?' with cancel and restart resume':''),async()=>{
 const f=await fixture();let active=true,released=0;const target:PairingReleaseTarget={...vectors.context,check:()=>{if(!active)throw Error('cancelled');}},operation=new LibraryClearOperation(timer);
 const ports={read:()=>f.store.read(),releaseStored:(old:any,run:any)=>f.store.releaseOwnershipForPairing(old,run),normal:async()=>{throw Error('unbound test cannot use old credentials');},possession:async()=>{released++;},progress:()=>{},clearAndSetOwner:(t:PairingReleaseTarget)=>f.store.resolveLibraryOwner({userId:t.userId,backendBaseUrl:'https://sly-data-plane.watchrss.cn'},'clear',()=>operation.run(true,{check:t.check},control=>f.repository().clearLibrary({privateData:true,control})))};
 try{
  if(cancel)f.setAfterDelete(()=>{active=false;});
  if(cancel){await expect(replacePairingAccount(target,ports)).rejects.toMatchObject({released:true,cleared:false,code:'pairing_clear_library_cancelled'});expect(await f.db.query('SELECT private_data FROM library_clear_journal')).toEqual([{private_data:1}]);expect(f.values.get('watchrss.library.owner')).toBe('old-owner');f.reopen();f.setAfterDelete(()=>{});active=true;await new LibraryClearOperation(timer).run(true,{},control=>f.repository().resumeLibraryClear(control));}
  else expect(await replacePairingAccount(target,ports)).toEqual({released:true,cleared:true});
  expect(released).toBe(1);
  for(const table of ['articles','channels','article_reading_state','sync_books','memo_notes','library_clear_journal'])expect(await f.db.query('SELECT * FROM '+table)).toEqual([]);
  for(const path of ['article_content/body.txt','books/book.jsonl','books/orphan.part','notes/assets/note.bin','sync_body/body.gz','watch-cloud-cache/piece'])expect(await f.files.stat(path)).toEqual({exists:false});
  expect(await f.files.stat('reader_assets/fonts/keep.ttf')).toEqual({exists:true});expect(await f.db.query('SELECT device_id FROM sync_local_identity')).toEqual([{device_id:target.deviceId}]);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
  if(!cancel)expect(f.values.get('watchrss.library.owner')).toBe(JSON.stringify(['https://sly-data-plane.watchrss.cn',target.userId]));
 }finally{await f.close();}
});
