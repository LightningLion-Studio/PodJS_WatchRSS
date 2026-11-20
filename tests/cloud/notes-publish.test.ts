import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './service-fixture';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {MemoRepository} from '../../src/notes/repository';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {decodeNoteCloudState,encodeNoteCloudState,exportNoteMarkdown} from '../../src/notes/cloud-state';
import {createNoteAssetReader,NOTE_IMAGE_LIMIT} from '../../src/notes/cloud-assets';
import {utf8Encode} from '../../src/cloud/types';
import {readWrss} from '../../src/cloud/wrss';
import {WatchCloudSyncService} from '../../src/cloud/service';
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64'));
async function setup(){const f=await fixture(),d=await dbFixture(),files=new Map<string,Uint8Array>();
 d.repo=new SqlLibrarySessionRepository(d.db,{...d.ports,noteAssetReader:async key=>{const raw=files.get(key);if(!raw)throw Error('cloud_note_asset_missing');return raw;},noteAssetWriter:async(key,b)=>{files.set(key,b);return 1;}});d.adapter=new WatchCloudLibraryAdapter(d.repo,'watch',cloudCrypto,enabled);f.session.library=d.adapter;
 let tick=100;const notes=new MemoRepository(d.db,'watch',()=> 'watch-note',()=>++tick);await notes.initialize();
 const published=async()=>{const head=f.heads.get('watch')!,m=await f.session.codec.decryptManifest(key,head.id,f.objects.get(head.manifestSha256)!);return {m,objects:await f.session.codec.restore(key,m,async h=>f.objects.get(h)!)};};return {f,d,files,notes,published};
}
test('watch directly publishes create/edit/pin/folder/delete and preserves edit ancestry',async()=>{const {f,d,notes,published}=await setup();try{
 const first=await notes.save({markdown:'# 新笔记 😀\n正文'});await d.db.execute('UPDATE memo_notes SET folder_id=?,pinned=1 WHERE note_id=?',['folder-1',first.noteId]);
 expect(await f.service.syncNow(true)).toBe(true);let out=decodeNoteCloudState((await published()).objects.get('notes-state.json')!)[0]!;expect(out).toMatchObject({markdown:first.markdown,folderId:'folder-1',pinned:true,baseMarkdown:first.markdown,modifiedBy:'watch'});
 const edited=await notes.save({noteId:first.noteId,markdown:'# 手表修改\n新正文'});expect(await f.service.syncNow(true)).toBe(true);out=decodeNoteCloudState((await published()).objects.get('notes-state.json')!)[0]!;expect(out.markdown).toBe(edited.markdown);expect(out.baseContentHash).toBe(first.contentHash);expect(out.baseMarkdown).toBe(first.markdown);
 await notes.delete(first.noteId);expect(await f.service.syncNow(true)).toBe(true);const deleted=await published();expect(decodeNoteCloudState(deleted.objects.get('notes-state.json')!)[0]!.deleted).toBe(true);expect(deleted.objects.has('notes-assets.zip')).toBe(false);
 }finally{d.sql.close();}});
test('missing/oversize attachments keep the complete own note domain; article publication and recovery continue',async()=>{const {f,d,notes,files,published}=await setup();try{
 await notes.save({markdown:'original'});expect(await f.service.syncNow(true)).toBe(true);const old=(await published()).objects.get('notes-state.json');
 await notes.save({noteId:'watch-note',markdown:'new ![PNG](assets/test.png)'});await d.repo.mergeCloud([],[article()],'local');expect(await f.service.syncNow(true)).toBe(false);
 let out=await published();expect(out.objects.get('notes-state.json')).toEqual(old);expect(out.objects.has('private-library.wrss')).toBe(true);expect(f.service.status.pendingItems).toBeGreaterThan(0);
 files.set('test.png',new Uint8Array(NOTE_IMAGE_LIMIT+1));expect(await f.service.syncNow(true)).toBe(false);expect((await published()).objects.get('notes-state.json')).toEqual(old);
 files.set('test.png',png);expect(await f.service.syncNow(true)).toBe(true);out=await published();const zip=await readWrss(out.objects.get('notes-assets.zip')!,crypto.gunzip);expect(zip.get('notes/assets/test.png')).toEqual(png);expect(zip.get('notes/watch-note.md')).toEqual(exportNoteMarkdown((await notes.get('watch-note'))!));
 }finally{d.sql.close();}});
test('failed snapshot completion retries without losing offline note or advancing its ancestor',async()=>{const {f,d,notes,published}=await setup();try{
 const n=await notes.save({markdown:'offline edit'});f.flags({failComplete:true});expect(await f.service.syncNow(true)).toBe(false);expect(await notes.get(n.noteId)).toEqual(n);expect(f.heads.has('watch')).toBe(false);f.flags({failComplete:false});expect(await f.service.syncNow(true)).toBe(true);expect(decodeNoteCloudState((await published()).objects.get('notes-state.json')!)[0]!.markdown).toBe(n.markdown);
 }finally{d.sql.close();}});
test('actual phone JVM imports PodJS wire/ZIP, preserves both concurrent edits, and republishes to PodJS',async()=>{const {d,notes,files}=await setup();const folder=mkdtempSync(join(tmpdir(),'podnotes-interop-'));try{
 files.set('test.png',png);const attachedMarkdown=utf8Encode('# 附件 😀\r\n原始 Markdown\n');files.set('attached.md',attachedMarkdown);const n=await notes.save({markdown:'# 字节 😀\n![PNG](assets/test.png)\n[附件](assets/attached.md)\n'});await d.db.execute('UPDATE memo_notes SET folder_id=?,pinned=1 WHERE note_id=?',['folder-A',n.noteId]);
 await d.db.execute("INSERT INTO memo_notes SELECT '目录/子项',folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes WHERE note_id='watch-note'");
 const payload=await d.adapter.exportPayloads(true),state=payload.objects.find(o=>o.name==='notes-state.json')!.bytes,zip=payload.objects.find(o=>o.name==='notes-assets.zip')!.bytes;
 const local={...decodeNoteCloudState(state)[0]!,markdown:'phone edit',baseMarkdown:'base',baseContentHash:await crypto.sha256(utf8Encode('base')),contentHash:await crypto.sha256(utf8Encode('phone edit')),modifiedBy:'phone',updatedAt:300};
 const remote={...local,markdown:'watch edit',contentHash:await crypto.sha256(utf8Encode('watch edit')),modifiedBy:'watch',updatedAt:301};
 const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');writeFileSync(join(folder,'input.json'),JSON.stringify([{label:'bytes',state:b64(state),zip:b64(zip)},{label:'conflict',local:b64(encodeNoteCloudState([local])),state:b64(encodeNoteCloudState([remote]))},{label:'delete',state:b64(encodeNoteCloudState([{...local,deleted:true,deletedAt:400}]))}]));
 const result=Bun.spawnSync(['python3','scripts/reference/verify-cloud-notes-phone.py',join(folder,'input.json'),join(folder,'output.json')],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode,result.stderr.toString()).toBe(0);const native=JSON.parse(readFileSync(join(folder,'output.json'),'utf8'));
 const p=native.cases[0];expect(decodeNoteCloudState(utf8Encode(JSON.stringify(p.state)))).toEqual(decodeNoteCloudState(state));expect(p.entries.find((e:any)=>e.path==='notes/assets/test.png').bytes).toBe(b64(png));expect(p.entries.find((e:any)=>e.path==='notes/assets/attached.md').bytes).toBe(b64(attachedMarkdown));expect(p.entries.find((e:any)=>e.path==='notes/watch-note.md').bytes).toBe(p.markdown['watch-note']);expect(p.entries.find((e:any)=>e.path==='notes/目录/子项.md').bytes).toBe(p.markdown['目录/子项']);
 const phone=await dbFixture();const phoneAssets=new Map<string,Uint8Array>();const phoneRepo=new SqlLibrarySessionRepository(phone.db,{...phone.ports,noteAssetWriter:async(id,raw)=>{phoneAssets.set(id,raw);return 1;}});const phoneAdapter=new WatchCloudLibraryAdapter(phoneRepo,'watch',cloudCrypto,enabled);try{await phoneAdapter.restorePayloads(new Map([['notes-state.json',utf8Encode(JSON.stringify(p.state))],['notes-assets.zip',new Uint8Array(Buffer.from(p.reexportZip,'base64'))]]),'phone');expect(phoneAssets.get('test.png')).toEqual(png);expect(phoneAssets.get('attached.md')).toEqual(attachedMarkdown);expect((await new MemoRepository(phone.db,'watch').get(n.noteId))!.markdown).toBe(n.markdown);}finally{phone.sql.close();}
 const c=native.cases[1];expect(c.state.notes[0].markdown).toBe('phone edit');expect(c.conflicts).toEqual([{noteId:n.noteId,base:'base',local:'phone edit',remote:'watch edit',remoteDeviceId:'watch'}]);
 const watch=await dbFixture();try{await watch.repo.mergeCloudNotes([remote]);await watch.repo.mergeCloudNotes([local]);expect((await new MemoRepository(watch.db,'watch').get(n.noteId))!.markdown).toBe('watch edit');expect((await watch.db.query('SELECT local_markdown,remote_markdown FROM note_merge_conflicts'))[0]).toEqual({local_markdown:'watch edit',remote_markdown:'phone edit'});}finally{watch.sql.close();}
 expect(native.cases[2].state.notes[0].deleted).toBe(true);
 }finally{d.sql.close();rmSync(folder,{recursive:true,force:true});}},120000);
test('asset reader rejects truncation and a concurrent file change',async()=>{const content=new Uint8Array(100000).fill(7);let changed=false;
 const reader=createNoteAssetReader(async<T>(method:string,args:any)=>{if(method==='file.stat')return {file:true,size:content.length} as T;if(method==='file.hash')return {sha256:changed?'0'.repeat(64):await crypto.sha256(content)} as T;if(method==='file.read'){changed=true;return {offset:args.offset,size:content.length,dataBase64:Buffer.from(content.subarray(args.offset,args.offset+args.maxBytes)).toString('base64')} as T;}throw Error(method);});await expect(reader('asset.png')).rejects.toThrow('cloud_note_asset_changed');
});
test('v2 primary hands off before all legacy business calls and retains pending ciphertext',async()=>{
 const f=await fixture(),bootstrap=f.client.bootstrap.bind(f.client);f.client.bootstrap=async()=>({...await bootstrap(),syncV2:{algorithm:'ES256',receiptKeyId:'a'.repeat(32),receiptSigningPublicKey:'test-only'}});let ready=0;
 f.session.prepareRestore=async()=>{throw Error('legacy restore must not run');};f.blobs.set('pending-body',new Uint8Array([1]));
 const service=new WatchCloudSyncService({primaryV2:true,keysReady:async()=>{ready++;},syncV2:async()=>({completionError:null}),open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'test',exclusive:async work=>work()},enabled);
 expect(await service.syncNow(true)).toBe(true);expect(ready).toBe(1);expect(f.calls.some(c=>/\/records|\/snapshots|\/sync\/exchange/.test(c.url))).toBe(false);expect(f.blobs.get('pending-body')).toEqual(new Uint8Array([1]));
});
test('v2 product with withdrawn announcement stops before legacy business requests',async()=>{
 const f=await fixture();const service=new WatchCloudSyncService({primaryV2:true,open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'test',exclusive:async work=>work()},enabled);
 expect(await service.syncNow(true)).toBe(false);expect(f.calls.some(c=>/\/records|\/snapshots|\/sync\/exchange/.test(c.url))).toBe(false);
});
