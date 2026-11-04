import {describe,test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {decodeNoteCloudState,NOTES_STATE_OBJECT,NOTES_ASSETS_OBJECT} from '../../src/notes/cloud-state';
import {phoneNotePlainText} from '../../src/notes/phone-text';
import {mergeNoteMarkdown} from '../../src/notes/merge';
import {MemoRepository} from '../../src/notes/repository';
import {createNoteAssetWriter} from '../../src/notes/cloud-assets';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {cloudRaw} from '../../src/cloud/compatibility';
import {rawJsonText} from '@podjs/framework/json-raw';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {writeWrss,readWrss} from '../../src/cloud/wrss';
import {syncNotes} from '../../src/sync/note-actions';
import {crypto,enabled,key} from './k2-crypto';
import {dbFixture,cloudCrypto,article} from './library-fixture';
import {fixture} from './service-fixture';
import type {SqlDatabase} from '../../src/core/types';
const dir=new URL('./fixtures/notesimport/',import.meta.url),vectors=JSON.parse(readFileSync(new URL('phone-vectors.json',dir),'utf8'));
const state=(notes:unknown[])=>utf8Encode(JSON.stringify({format:'watchrss-notes',version:1,notes}));
const decode=(n:any)=>decodeNoteCloudState(state([n]))[0];
function store(path=':memory:'){
 const sql=new Database(path);const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>sql.transaction(()=>ss.forEach(s=>sql.query(s.sql).run(...(s.params??[]) as any[])))()};
 return {sql,db,repo:new MemoRepository(db,'mini',undefined,()=>999)};
}
const cols='note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at';
async function seed(db:SqlDatabase,n:ReturnType<typeof decode>){await db.execute('INSERT INTO memo_notes('+cols+') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[n.noteId,n.folderId,n.title,n.markdown,n.plainText,n.contentHash,n.baseContentHash,n.baseMarkdown,+n.pinned,n.createdAt,n.updatedAt,n.modifiedBy,+n.deleted,n.deletedAt]);}
const wire=(n:any)=>({id:n.noteId,folder:n.folderId,title:n.title,markdown:n.markdown,hash:n.contentHash,base:n.baseMarkdown,updatedAt:n.updatedAt,modifiedBy:n.modifiedBy,pinned:n.pinned,deleted:n.deleted,deletedAt:n.deletedAt,createdAt:n.createdAt});
describe('actual phone JVM oracle',()=>{
 for(const c of vectors.plain)test('phone plain '+JSON.stringify(c.input).slice(0,40),()=>expect(phoneNotePlainText(c.input)).toBe(c.expected));
 for(const c of vectors.merge)test('diff3 '+c.name,()=>{const result=mergeNoteMarkdown(c.base,c.local,c.remote);expect(result===null?{conflict:true}:{markdown:result}).toEqual(c.expected);});
 for(const c of vectors.apply)test('applyRemote '+c.name,async()=>{
  const f=store();try{await f.repo.initialize();if(c.local)await seed(f.db,decode(c.local));const remote=decode(c.remote);await f.repo.applyRemote(remote);expect(wire((await f.repo.allIncludingDeleted())[0])).toEqual(c.expected.note);
   const conflicts=(await f.db.query('SELECT conflict_id AS conflictId,note_id AS noteId,base_markdown AS baseMarkdown,local_markdown AS localMarkdown,remote_markdown AS remoteMarkdown,remote_device_id AS remoteDeviceId,created_at AS createdAt FROM note_merge_conflicts'));expect(conflicts).toEqual(c.expected.conflicts);
   // Simulate a kill after SQL commit but before the coordinator receipt.
   const reopened=new MemoRepository(f.db,'mini',undefined,()=>1001);expect(await reopened.applyRemote(remote)).toBe(0);expect(wire((await reopened.allIncludingDeleted())[0])).toEqual(c.expected.note);expect(await f.db.query('SELECT * FROM note_merge_conflicts')).toHaveLength(conflicts.length);
  }finally{f.sql.close();}
 });
});
test('mini codec output imports into the real existing memo list, then local phone link uses the same ID',async()=>{const f=await dbFixture();try{const bytes=new Uint8Array(readFileSync(new URL('mini-state.json',dir)));const result=await f.adapter.restorePayloads(new Map([[NOTES_STATE_OBJECT,bytes]]),'mini');expect(result.changed).toBe(1);const repo=new MemoRepository(f.db,'watch');const notes=await repo.list();expect(notes).toHaveLength(1);expect(notes[0]).toMatchObject({noteId:'note-1',title:'Phone',pinned:true});expect((await syncNotes({action:'syncNotes',notes},repo,async()=>'watch')).applied).toBe(0);expect(await repo.list()).toHaveLength(1);}finally{f.sql.close();}});
test('per-note resume skips a committed prefix after an interrupted import',async()=>{const f=await dbFixture();try{const a={...vectors.phoneState.notes.find((n:any)=>!n.deleted),id:'resume-a'},b={...a,id:'resume-b'};const done=new Set<string>();let killed=false;const cp={has:(k:string)=>done.has(k),check:async()=>{if(done.size&&!killed){killed=true;throw Error('kill');}},commit:async(k:string)=>{done.add(k);},result:()=>0};const payload=new Map([[NOTES_STATE_OBJECT,state([a,b])]]);await expect(f.adapter.restorePayloads(payload,'phone',[],{checkpoint:cp})).rejects.toThrow('kill');expect(await new MemoRepository(f.db,'watch').list()).toHaveLength(1);const reopened=new WatchCloudLibraryAdapter(f.repo,'watch',cloudCrypto,enabled);await reopened.restorePayloads(payload,'phone',[],{checkpoint:cp});expect(await new MemoRepository(f.db,'watch').list()).toHaveLength(2);expect(done.size).toBe(2);}finally{f.sql.close();}});
test('large body and ancestry survive exactly, malformed/future state stops import',async()=>{const f=store();try{await f.repo.initialize();const n={...vectors.phoneState.notes.find((n:any)=>!n.deleted),markdown:'云端正文\n'.repeat(250000),base:'祖先\n'.repeat(250000)};await f.repo.applyRemote(decode(n));expect((await f.repo.list())[0].markdown).toBe(n.markdown);expect((await f.repo.list())[0].baseMarkdown).toBe(n.base);expect(()=>decodeNoteCloudState(state([n,n]))).toThrow();expect(()=>decodeNoteCloudState(utf8Encode('{"format":"watchrss-notes","version":2,"notes":[]}'))).toThrow('cloud_format_notes_unsupported');}finally{f.sql.close();}});
test('image-only and legacy ZIP restore images only; checkpoint covers durable publication',async()=>{const f=await dbFixture();try{const files=new Map<string,Uint8Array>();const repo=Object.assign(f.repo,{mergeCloudNoteAsset:async(k:string,b:Uint8Array)=>{files.set(k,b);return 1;}});const adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);const bytes=new Uint8Array(readFileSync(new URL('mini-image-assets.zip',dir)));const zip=await readWrss(bytes,crypto.gunzip);const result=await adapter.restorePayloads(new Map([[NOTES_ASSETS_OBJECT,bytes]]),'mini');expect(result.changed).toBeGreaterThan(0);for(const [path,b]of zip)if(path.startsWith('notes/assets/'))expect(files.get(path.slice(13))).toEqual(b);expect(await new MemoRepository(f.db,'watch').allIncludingDeleted().catch(()=>[])).toEqual([]);await expect(adapter.restorePayloads(new Map([[NOTES_ASSETS_OBJECT,writeWrss(new Map([['notes/assets/sub/evil',utf8Encode('x')]]))]]),'mini')).rejects.toThrow('cloud_note_asset_path_invalid');}finally{f.sql.close();}});
test('atomic image writer retains target on a failed commit and retries safely',async()=>{const files=new Map<string,Uint8Array>([['notes/assets/image.png',utf8Encode('old')]]);let fail=true;const host=async<T>(method:string,a:any):Promise<T>=>{
 if(method==='file.stat')return {file:files.has(a.path),size:files.get(a.path)?.length??0} as T;
 if(method==='file.hash')return {sha256:await crypto.sha256(files.get(a.path)!)} as T;
 if(method==='file.createTemp'){files.set('notes/assets/.pod-write-test.part',new Uint8Array());return {path:'notes/assets/.pod-write-test.part'} as T;}
 if(method==='file.write'){const b=Buffer.from(a.dataBase64,'base64'),old=files.get(a.path)!;expect(old.length).toBe(a.expectedOffset);files.set(a.path,new Uint8Array([...old,...b]));return {size:old.length+b.length} as T;}
 if(method==='file.commit'){if(fail)throw Error('disk full');const b=files.get(a.path)!;expect(await crypto.sha256(b)).toBe(a.expectedSha256);files.set(a.target,b);return {} as T;}
 if(method==='file.delete'){files.delete(a.path);return {} as T;}throw Error(method);
 };const write=createNoteAssetWriter(host),body=utf8Encode('new');await expect(write('image.png',body)).rejects.toThrow('disk full');expect(utf8Decode(files.get('notes/assets/image.png')!)).toBe('old');fail=false;expect(await write('image.png',body)).toBe(1);expect(await write('image.png',body)).toBe(0);
});
test('full encrypted coordinator imports notes and safely handles no-notes and older manifests',async()=>{for(const objects of [[],[{name:NOTES_STATE_OBJECT,bytes:state(vectors.phoneState.notes)}]]){const f=await fixture(),db=await dbFixture();try{f.session.library=db.adapter;const p=await f.phone({objects});expect(await f.service.syncNow(true,'all')).toBe(true);if(objects.length){expect(await new MemoRepository(db.db,'watch').list()).toHaveLength(1);expect(await new MemoRepository(db.db,'watch').allIncludingDeleted()).toHaveLength(2);}expect(await f.state.applied('phone',true)).toBe(p.head.deviceSequence);}finally{db.sql.close();}}});
test('watch publication carries inherited note descriptors and ciphertext exactly; foreign heads stay independent',async()=>{
 const codec=new WatchCloudCodec(crypto,enabled),base=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'base',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:NOTES_STATE_OBJECT,bytes:state(vectors.phoneState.notes)},{name:NOTES_ASSETS_OBJECT,bytes:new Uint8Array(readFileSync(new URL('mini-image-assets.zip',dir)))}]});
 const previous=await codec.decryptManifest(key,'base',base.encryptedManifest);const next=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{phone:'p',mini:'m'},observedHeads:{phone:1,mini:1},objects:[],previous});
 for(const o of previous.objects){const out=next.manifest.objects.find(v=>v.name===o.name)!;expect(rawJsonText(cloudRaw(out)!)).toBe(rawJsonText(cloudRaw(o)!));for(const c of out.chunks)expect(next.newChunks.has(c.ciphertextSha256)).toBe(false);}
 const f=await fixture(),db=await dbFixture();try{f.session.library=db.adapter;await f.phone({sourceDeviceId:'phone',objects:[{name:NOTES_STATE_OBJECT,bytes:state(vectors.phoneState.notes)}]});await f.phone({sourceDeviceId:'mini',objects:[{name:NOTES_STATE_OBJECT,bytes:new Uint8Array(readFileSync(new URL('mini-state.json',dir)))}]});const foreign=[...f.heads.values()];await db.repo.mergeCloud([], [article()], 'local-fixture');expect(await f.service.syncNow(true,'all')).toBe(true);expect(f.heads.has('watch')).toBe(true);for(const h of foreign)expect(f.heads.get(h.sourceDeviceId)).toEqual(h);expect(f.service.status.message).not.toContain('unknown_object_conflicting_heads');}finally{db.sql.close();}
});

test('portable entity table preserves the existing watch decoder for every HTML5 name and numeric edge',async()=>{
 const {nativeEntities}=await import('../../src/notes/text'),{noteHtmlEntities}=await import('../../src/notes/html-entities'),{decodeHTML,decodeHTMLStrict}=await import('entities');
 const previous=(value:string)=>value.replace(/&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z]+[0-9]*;?)/g,token=>{
  if(token.startsWith('&#')){const code=parseInt(token.slice(/^&#x/i.test(token)?3:2),/^&#x/i.test(token)?16:10);if(code===0||code>=0xd800&&code<=0xdfff)return String.fromCharCode(code);return decodeHTML(token);}
  if(token.endsWith(';'))return decodeHTMLStrict(token);const complete=decodeHTMLStrict(token+';');return complete===decodeHTML(token)?complete:token;
 });
 for(const token of ['&constructor','&toString;','&hasOwnProperty'])expect(nativeEntities(token)).toBe(previous(token));
 for(const name of Object.keys(noteHtmlEntities))for(const token of ['&'+name,'&'+name.replace(/;$/,''),'&'+name.replace(/;$/,'')+'unknown'])expect(nativeEntities(token)).toBe(previous(token));
 for(const code of [0,1,9,128,129,130,159,160,0xd800,0xdfff,0xe000,0x10ffff,0x110000,999999999999])for(const token of [`&#${code};`,`&#x${code.toString(16)};`])expect(nativeEntities(token)).toBe(previous(token));
});
test('unsupported notes stop the real coordinator before head receipt and ACK',async()=>{const f=await fixture(),db=await dbFixture();try{f.session.library=db.adapter;await f.phone({objects:[{name:NOTES_STATE_OBJECT,bytes:utf8Encode('{"format":"watchrss-notes","version":2,"notes":[]}')}]});expect(await f.service.syncNow(true,'all')).toBe(false);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(false);}finally{db.sql.close();}});

test('a concurrent editor write aborts the whole import transaction and leaves no remote receipt',async()=>{const f=store();try{await f.repo.initialize();const local=decode(vectors.phoneState.notes.find((n:any)=>!n.deleted));await seed(f.db,local);let mutate=true;const db={...f.db,transaction:async(ss:any[])=>{if(mutate&&ss.some(s=>s.sql.startsWith('INSERT INTO note_merge_guard'))){mutate=false;await f.db.execute("UPDATE memo_notes SET markdown='concurrent edit',content_hash='edited' WHERE note_id=?",[local.noteId]);}await f.db.transaction(ss);}};const repo=new MemoRepository(db,'watch',undefined,()=>999),remote={...local,title:'remote pin',pinned:true,updatedAt:local.updatedAt+1};await expect(repo.applyRemote(remote)).rejects.toThrow('CHECK constraint failed');expect((await f.repo.list())[0].markdown).toBe('concurrent edit');expect(await f.db.query('SELECT * FROM note_cloud_receipts')).toEqual([]);expect(await f.db.query('SELECT * FROM note_merge_guard')).toEqual([]);}finally{f.sql.close();}});

test('an inherited notes object cannot be replaced, removed or dropped during key rotation',async()=>{
 const codec=new WatchCloudCodec(crypto,enabled),input={accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'carry',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:NOTES_STATE_OBJECT,bytes:state(vectors.phoneState.notes)}]},base=await codec.create(input),previous=await codec.decryptManifest(key,'carry',base.encryptedManifest);
 for(const edit of [{keyVersion:2,objects:[]},{objects:[] as any[],removedObjectNames:[NOTES_STATE_OBJECT]},{objects:[{name:NOTES_STATE_OBJECT,bytes:state([])}]}])await expect(codec.create({...input,snapshotId:'next',sequence:2,previous,...edit})).rejects.toThrow('cloud_format_notes_preservation_pending');
 const f=await fixture();await f.phone({...input,sourceDeviceId:'watch'});const own=f.heads.get('watch');f.flags({version:2});expect(await f.service.syncNow(true,'all')).toBe(false);expect(f.heads.get('watch')).toEqual(own);
});

test('SIGKILL after a file-SQLite merge commit and before a restore receipt does not re-merge the body',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'notesimport-kill-')),path=join(dir,'notes.sqlite');
 const c=vectors.apply.find((v:any)=>v.name==='independent'),f=store(path);await f.repo.initialize();await seed(f.db,decode(c.local));f.sql.close();
 try{
  const source=`import {Database} from 'bun:sqlite';import {MemoRepository} from ${JSON.stringify(new URL('../../src/notes/repository.ts',import.meta.url).pathname)};const s=new Database(${JSON.stringify(path)});const d={query:async(q,p=[])=>s.query(q).all(...p),execute:async(q,p=[])=>{s.query(q).run(...p)},transaction:async ss=>s.transaction(()=>ss.forEach(v=>s.query(v.sql).run(...(v.params??[]))))()};await new MemoRepository(d,'mini',undefined,()=>999).applyRemote(${JSON.stringify(decode(c.remote))});process.kill(process.pid,'SIGKILL');`;
  const child=Bun.spawn([Bun.which('bun')!,'-e',source],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(137);
  const resumed=store(path);try{expect(wire((await resumed.repo.list())[0])).toEqual(c.expected.note);expect(await resumed.repo.applyRemote(decode(c.remote))).toBe(0);expect(await resumed.db.query('SELECT * FROM note_merge_conflicts')).toEqual([]);expect(await resumed.db.query('SELECT * FROM note_cloud_receipts')).toHaveLength(1);}finally{resumed.sql.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
