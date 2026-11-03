import {test,expect} from 'bun:test';
import {bookFixture} from '../books/fixture';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {bookPackageLines} from '../../src/books/package';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from './library-fixture';
import {enabled} from './k2-crypto';
test('unchanged export verifies packages without transferring bodies; lazy upload is byte identical and tamper remains fenced',async()=>{
 const f=await bookFixture();try{
  const sourceUrl='https://watchrss.local/import-txt-novel/lazy',chapter={chapterIndex:1,title:'Chapter',contentText:'readable'.repeat(20000),contentHtml:null,url:sourceUrl+'/chapter/1'};
  const fingerprint=await bookFingerprint([await chapterHash(1,chapter.title,chapter.contentText,f.bookPorts.sha256)],f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256),info=await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:1,sourceUrl,kind:'txt'},[chapter]),1e6);await f.store.installPackage(info,id);
  let reads=0,hashes=0,transferred=0;
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:{...f.files,hash:async path=>{hashes++;return f.files.hash(path);},read:async(...a)=>{const r=await f.files.read(...a);transferred+=r.bytes.length;return r;}}});
  const original=repo.cloudBookBody.bind(repo);repo.cloudBookBody=async id=>{reads++;return original(id);};
  const library=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled),eager=await library.exportPayloads(true);reads=0;transferred=0;hashes=0;
  const lazy=await library.exportPayloads(true,true);expect(reads).toBe(0);expect(hashes).toBe(1);expect(transferred).toBeLessThanOrEqual(65536);expect(lazy.fingerprint).toBe(eager.fingerprint);expect(lazy.bookIds).toEqual([id]);expect(lazy.materialize).toBeDefined();
  await lazy.materialize!();expect(reads).toBe(1);expect(lazy.objects).toEqual(eager.objects);await lazy.materialize!();expect(reads).toBe(1);
  const pending=await library.exportPayloads(true,true),live=(await f.store.package(id))!,saved=f.data.get(live.path)!.slice();f.data.get(live.path)![saved.length-2]^=1;
  await expect(pending.materialize!()).rejects.toThrow('cloud_book_package_changed');const damaged=await library.exportPayloads(true,true);expect(damaged.pendingPrivateArticles).toBe(1);expect(damaged.bookIds).toEqual([]);expect(damaged.objects).toEqual([]);
  f.data.set(live.path,saved);f.data.delete(live.path);const missing=await library.exportPayloads(true,true);expect(missing.pendingPrivateArticles).toBe(1);expect(missing.objects).toEqual([]);
 }finally{f.sql.close();}
});
