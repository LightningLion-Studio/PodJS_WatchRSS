import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,readdir,stat,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {MemoRepository} from '../../src/notes';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {clearPrivateContentFiles,LIBRARY_CONTENT_ROOTS,PRIVATE_CONTENT_ROOTS,type PrivateLibraryFiles} from '../../src/core/clear-private-files';
import {LibraryClearOperation,type LibraryClearProgress} from '../../src/core/library-clear';
import {createApplicationActionHandler} from '../../src/sync/application-actions';
const timer=(ms:number)=>{let handle:ReturnType<typeof setTimeout>;const result=new Promise<void>(resolve=>{handle=setTimeout(resolve,ms);});return {result,cancel:()=>clearTimeout(handle!)};};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'watch-library-clear-')),dbPath=join(root,'library.db');let sql=new Database(dbPath);
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...s.params??[] as any);})()};
 sql.exec('PRAGMA foreign_keys=ON');await initializeSchema(db,{seedBuiltinChannels:false});await new MemoRepository(db,'test').initialize();
 await db.execute("INSERT INTO sync_local_identity VALUES(1,'keep-device','keep-order')");
 await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1),(2,'https://test.invalid/rss','RSS',1)");
 await db.transaction(Array.from({length:8},(_,i)=>({sql:'INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,2,?,?,?,?,1)',params:[i+1,'Article '+i,'watchrss-watch-content:large.txt','https://test.invalid/'+i,'key-'+i]})));
 await db.transaction(Array.from({length:7},(_,i)=>({sql:'INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(?,.5,1,20,\'hash\')',params:[i+1]})));
 await db.execute("INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,package_path) VALUES('book','fingerprint',1,'{}','books/book.jsonl')");
 await db.execute("INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source) VALUES('book',0,'{}',1,1,1,20,'hash','local')");
 await db.execute("INSERT INTO offline_media_jobs VALUES(1,1,'download',0,0,NULL)");
 const put=async(path:string,body:string|Uint8Array)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);};
 for(const path of ['books/book.jsonl','books/.pod-write-orphan.part','books/part-orphan.bin','offline/rss/1/media.mp4','sync_body/body.gz','feeds/stale.xml','original/fetch.html','managed-cache/rss-offline/media'])await put(path,'private');
 await put('article_content/large.txt',new Uint8Array(4*1024*1024).fill(65));
 await put('notes/assets/keep.png','standalone note');await put('reader_assets/fonts/keep.ttf','font');await put('credentials/keep','account');
 const removed:string[]=[];let afterRemove:(path:string)=>void=()=>{};
 const files:PrivateLibraryFiles={list:async path=>({entries:await Promise.all((await readdir(join(root,path),{withFileTypes:true}).catch((error:any)=>{if(error.code==='ENOENT')return [];throw error;})).map(async e=>({path:path+'/'+e.name,file:e.isFile(),directory:e.isDirectory()})))}),remove:async path=>{await unlink(join(root,path));removed.push(path);afterRemove(path);},stat:async path=>({exists:await stat(join(root,path)).then(()=>true,(error:any)=>{if(error.code==='ENOENT')return false;throw error;})})};
 const make=()=>new SqlLibrarySessionRepository(db,{codec:{} as never,text:{} as never,uri:{} as never,files:{} as never,migrateReading:async()=>{},cleanupRemovedContent:async()=>{throw Error('production uses namespace sweep');},clearContentFiles:(privateData,control)=>clearPrivateContentFiles(files,{roots:privateData?PRIVATE_CONTENT_ROOTS:LIBRARY_CONTENT_ROOTS,check:()=>control?.check(),onDeleted:count=>control?.progress('files',count)})});
 return {root,db,files,removed,make,setAfterRemove:(fn:typeof afterRemove)=>{afterRemove=fn;},reopen:()=>{sql.close();sql=new Database(dbPath);sql.exec('PRAGMA foreign_keys=ON');},close:async()=>{sql.close();await rm(root,{recursive:true,force:true});}};
}
async function expectEmpty(f:Awaited<ReturnType<typeof fixture>>){for(const table of ['channels','articles','article_reading_state','sync_books','sync_book_reading','offline_media_jobs','library_clear_journal'])expect(await f.db.query('SELECT * FROM '+table)).toEqual([]);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);expect(await f.db.query('SELECT device_id FROM sync_local_identity')).toEqual([{device_id:'keep-device'}]);async function descendants(root:string):Promise<string[]>{const all:string[]=[];for(const entry of (await f.files.list(root)).entries){if(entry.directory)all.push(...await descendants(entry.path));else all.push(entry.path);}return all;}for(const root of LIBRARY_CONTENT_ROOTS)expect(await descendants(root)).toEqual([]);expect(await f.files.stat('reader_assets/fonts/keep.ttf')).toEqual({exists:true});expect(await f.files.stat('credentials/keep')).toEqual({exists:true});}

test('unbound remote clear removes real SQLite books, 7 reading rows and all body/partial files without orphan files',async()=>{const f=await fixture();try{
 const operation=new LibraryClearOperation(timer),progress:Readonly<LibraryClearProgress>[]=[];
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'',notesChanged:()=>{},clearLibrary:()=>operation.run(false,{onProgress:p=>progress.push(p)},control=>f.make().clearLibrary({control}))});
 expect(await handler({action:'clearLibrary'})).toEqual({success:true,action:'clearLibrary'});
 await expectEmpty(f);expect(await f.files.stat('notes/assets/keep.png')).toEqual({exists:true});
 expect(progress.at(-1)).toEqual({phase:'complete',deletedFiles:9,databaseCommitted:true});
 for(const p of progress)expect(p.deletedFiles).toBeLessThanOrEqual(f.removed.length);
 }finally{await f.close();}});

test('cancel after SQL commit leaves durable intent; a new SQLite connection and repository resume every orphan file',async()=>{const f=await fixture();try{
 const operation=new LibraryClearOperation(timer);let fired=false;
 f.setAfterRemove(()=>{if(!fired){fired=true;operation.cancel();}});
 await expect(operation.run(true,{},control=>f.make().clearLibrary({privateData:true,control}))).rejects.toMatchObject({code:'clear_library_cancelled'});
 // Let the in-flight host remove return and release the operation, not a fake restart of live IO.
 for(let i=0;i<30&&operation.running;i++)await new Promise(resolve=>setTimeout(resolve,1));
 expect(operation.running).toBe(false);expect(operation.snapshot().phase).toBe('cancelled');
 expect(await f.db.query('SELECT private_data FROM library_clear_journal')).toEqual([{private_data:1}]);
 expect(await f.db.query('SELECT * FROM articles')).toEqual([]);expect(f.removed.length).toBe(1);
 f.reopen();f.setAfterRemove(()=>{});
 const recovery=new LibraryClearOperation(timer);await recovery.run(true,{},control=>f.make().resumeLibraryClear(control));
 await expectEmpty(f);expect(await f.files.stat('notes/assets/keep.png')).toEqual({exists:false});
 }finally{await f.close();}});

test('SQL rollback keeps both rows and files; cleanup failure is classified and restart remains resumable',async()=>{const f=await fixture();try{
 await f.db.execute("CREATE TRIGGER fail_clear BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
 let operation=new LibraryClearOperation(timer);
 await expect(operation.run(false,{},control=>f.make().clearLibrary({control}))).rejects.toMatchObject({code:'clear_library_database'});
 expect(await f.db.query('SELECT count(*) n FROM articles')).toEqual([{n:8}]);expect(await f.db.query('SELECT * FROM library_clear_journal')).toEqual([]);expect(f.removed).toEqual([]);
 await f.db.execute('DROP TRIGGER fail_clear');
 const remove=f.files.remove;f.files.remove=async()=>{throw Error('fixture access denied');};operation=new LibraryClearOperation(timer);
 await expect(operation.run(false,{},control=>f.make().clearLibrary({control}))).rejects.toMatchObject({code:'clear_library_files'});
 expect(await f.db.query('SELECT private_data FROM library_clear_journal')).toEqual([{private_data:0}]);
 f.files.remove=remove;f.reopen();await f.make().resumeLibraryClear();await expectEmpty(f);
 }finally{await f.close();}});

test('deadline or cancellation while a non-cooperative task waits cannot run late destructive work',async()=>{
 for(const cancel of [false,true]){
  let finish!:()=>void,mutations=0;const stalled=new Promise<void>(resolve=>{finish=resolve;}),operation=new LibraryClearOperation(timer);
  const result=operation.run(false,{timeoutMs:15},async control=>{control.progress('quiescing');await stalled;control.check();mutations++;});
  if(cancel)operation.cancel();
  await expect(result).rejects.toMatchObject({code:cancel?'clear_library_cancelled':'clear_library_timeout'});
  if(!cancel){expect(operation.running).toBe(true);expect(operation.run(false,{},async()=>{mutations++;})).toBe(result);}
  finish();for(let i=0;i<5;i++)await Promise.resolve();
  expect(mutations).toBe(0);
 }
});

test('late concurrent SQLite writer prevents success and preserves cleanup intent for retry',async()=>{const f=await fixture();try{
 let wrote=false;f.setAfterRemove(()=>{if(!wrote){wrote=true;void f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(99,'https://racer.invalid','Racer',1)");}});
 const operation=new LibraryClearOperation(timer);
 await expect(operation.run(false,{},control=>f.make().clearLibrary({control}))).rejects.toMatchObject({code:'clear_library_changed'});
 expect((await f.db.query('SELECT * FROM library_clear_journal')).length).toBe(1);
 expect(operation.snapshot().phase).toBe('failed');
 f.setAfterRemove(()=>{});await f.make().clearLibrary();await expectEmpty(f);
 }finally{await f.close();}});

test('a completed cleanup cannot turn into cancellation when its progress observer closes the page',async()=>{
 const operation=new LibraryClearOperation(timer);
 const stop=operation.subscribe(progress=>{if(progress.phase==='complete')operation.cancel();});
 try{await operation.run(false,{},async control=>{control.progress('verification');});expect(operation.snapshot().phase).toBe('complete');}finally{stop();}
});
