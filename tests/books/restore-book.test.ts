import {test,expect} from 'bun:test';
import {bookFixture} from './fixture';
import {SqlBookStore} from '../../src/books/store';
import {bookPackageLines} from '../../src/books/package';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {SnapshotYieldBudget} from '../../src/cloud/snapshot-deferral';
async function original(f:Awaited<ReturnType<typeof bookFixture>>,count:number,text='汉😀 original'){
 const source='https://watchrss.local/import-epub/resumable',chapters=Array.from({length:count},(_,i)=>({chapterIndex:i+1,title:'Chapter '+i,contentText:text+i,contentHtml:null,url:source+'/chapter/'+(i+1)}));
 const hashes=await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,f.bookPorts.sha256))),fingerprint=await bookFingerprint(hashes,f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256);
 const info=await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Original',chapterCount:count,sourceUrl:source,kind:'epub'},chapters),512*1024*1024);
 return {id,info,fingerprint};
}
test('RESTOREBOOK cold windows resume SQL validation/staging receipts and publish one complete 5600-chapter directory',async()=>{
 const f=await bookFixture();try{
  const {id,info}=await original(f,5600);const receipts=new Set<string>();let window=0,finished=false,hashes=0,validated=0;
  const db={...f.db,query:async(q:string,p:readonly unknown[]=[])=>{if(q.includes('chapter_index>?')||q.includes('AND a.id>?'))expect(/OFFSET/i.test(q)).toBe(false);const rows=await f.db.query(q,p);expect(rows.length).toBeLessThanOrEqual(1000);return rows;}};
  while(!finished&&++window<50){let left=12,stop=false;const cp={scope:async()=>'current-owner-epoch',has:(u:string)=>receipts.has(u),commit:async(u:string)=>{receipts.add(u);if(--left<=0)stop=true;},check:async()=>{if(stop)throw Error('cloud_sync_deadline_exceeded');}};
   const store=new SqlBookStore(db,{...f.bookPorts,sha256:async b=>{hashes++;return f.bookPorts.sha256(b);}});
   try{await store.installPackage(info,id,cp);finished=true;}catch(e){expect(String(e)).toContain('cloud_sync_deadline_exceeded');expect((await f.db.query('SELECT count(*) n FROM articles'))[0].n).toBe(0);}
   const n=Number((await f.db.query('SELECT count(*) n FROM sync_book_validation'))[0].n);expect(n).toBeGreaterThanOrEqual(validated);validated=n;
  }
  expect(finished).toBe(true);expect(window).toBeGreaterThan(2);expect(validated).toBe(5600);expect(hashes).toBeLessThan(17000);
  expect((await f.db.query('SELECT count(*) n FROM articles'))[0].n).toBe(5600);
  expect((await f.db.query('SELECT registration_complete FROM sync_books WHERE book_id=?',[id]))[0].registration_complete).toBe(1);
  // Same authenticated package avoids all line traversal and per-row merges.
  let queries=0;const store=new SqlBookStore({...f.db,query:async(...a)=>{queries++;return f.db.query(...a);}},{...f.bookPorts,files:{...f.files,lines:()=>{throw Error('full traversal');},read:async()=>{throw Error('range traversal');}}});
  expect(await store.installPackage((await f.store.package(id))!,id)).toBe(0);expect(queries).toBeLessThan(30);
 }finally{f.sql.close();}
},90000);
test('RESTOREBOOK lost SQL/secure replies adopt validation without hashing the committed prefix',async()=>{
 const f=await bookFixture();try{
  const {id,info}=await original(f,70);let fail=true;const receipts=new Set<string>(),cp={scope:async()=>'scope',has:(u:string)=>receipts.has(u),check:async()=>{},commit:async(u:string)=>{if(fail){fail=false;throw Error('lost receipt reply');}receipts.add(u);}};
  await expect(f.store.installPackage(info,id,cp)).rejects.toThrow('lost receipt reply');
  expect((await f.db.query('SELECT count(*) n FROM sync_book_validation'))[0].n).toBe(32);
  const cursor=Number((await f.db.query('SELECT validated_offset FROM sync_book_install'))[0].validated_offset);const offsets:number[]=[];
  const cold=new SqlBookStore(f.db,{...f.bookPorts,files:{...f.files,read:async(p,at,max)=>{offsets.push(at);return f.files.read(p,at,max);}}});await cold.installPackage(info,id,cp);
  expect(offsets[0]).toBe(cursor);expect(receipts.size).toBeGreaterThan(1);
 }finally{f.sql.close();}
});
test('RESTOREBOOK immutable source hash, scoped receipts, invalid directory and old readable package remain fenced',async()=>{
 const f=await bookFixture();try{
  const {id,info}=await original(f,70);await f.store.installPackage(info,id);
  const live=(await f.store.package(id))!,before=f.data.get(live.path)!.slice();
  // A different valid package header has the same original identity.
  const changed=new TextDecoder().decode(before).replace('Original','Replacement');const candidate=await f.files.writeBytes(new TextEncoder().encode(changed));
  let commits=0;const cp={scope:async()=>'scope',has:()=>false,check:async()=>{},commit:async()=>{if(++commits===2)throw Error('stop before publication');}};
  await expect(new SqlBookStore(f.db,f.bookPorts).installPackage(candidate,id,cp)).rejects.toThrow('stop before publication');expect((await f.store.package(id))!.path).toBe(live.path);expect(f.data.get(live.path)).toEqual(before);
  const broken=await f.files.writeBytes(new TextEncoder().encode(changed.replace('original0','forged0')));
  await expect(f.store.installPackage(broken,id)).rejects.toThrow('book_package_invalid');expect((await f.store.package(id))!.path).toBe(live.path);
  await expect(f.store.installPackage({...candidate,sha256:'0'.repeat(64)},id)).rejects.toThrow('book_package_changed');
  await f.store.installPackage(candidate,id);expect((await f.store.package(id))!.sha256).toBe(candidate.sha256);expect(f.data.get(live.path)).toEqual(before);
 }finally{f.sql.close();}
});
test('RESTOREBOOK stalled validation replay is rejected before a second text traversal; receipts reset the frontier',()=>{
 const budget=new SnapshotYieldBudget(),args={path:'books/part-'+'a'.repeat(64)+'.bin',strictUtf8:true};budget.stalled(true);budget.before('file.openText',args);budget.completed('file.openText',args);
 expect(()=>budget.before('file.openText',args)).toThrow('cloud_snapshot_work_timeout');budget.stalled(false);expect(()=>budget.before('file.openText',args)).not.toThrow();budget.stalled(true);expect(()=>budget.before('file.openText',{...args,path:args.path+'other'})).not.toThrow();
});
test('RESTOREBOOK interrupted stage keeps newer local reading and saved clocks, then repairs a missing package',async()=>{
 const f=await bookFixture();try{
  const {id,info}=await original(f,70);await f.store.installPackage(info,id);const old=(await f.store.package(id))!,bytes=f.data.get(old.path)!.slice();
  await f.store.mergeReading({bookId:id,chapterIndex:1,isRead:true,readingProgress:.25,readingPositionBytes:10,readingPositionContentHash:'old',readingPositionChangedAt:100,sourceDeviceId:'phone',favoriteSaved:true,favoriteChangedAt:100,favoriteSortOrder:1});
  const input=await f.files.writeBytes(new TextEncoder().encode(new TextDecoder().decode(bytes).replace('Original','New header')));
  const cp={scope:async()=>'current-scope',has:()=>false,check:async()=>{},commit:async(u:string)=>{if(u.startsWith('book-stage:'))throw Error('stage reply lost');}};
  await expect(f.store.installPackage(input,id,cp)).rejects.toThrow('stage reply lost');
  const item=(await f.db.query('SELECT item_id FROM sync_book_chapters WHERE book_id=? AND chapter_index=1',[id]))[0].item_id;
  await f.db.execute("UPDATE article_reading_state SET progress=.875,changed_at=500,position_bytes=99,position_hash='current' WHERE article_id=?",[item]);
  await f.db.execute("UPDATE article_saved_states SET saved=0,changed_at=600 WHERE article_id=? AND save_type='favorite'",[item]);
  await new SqlBookStore(f.db,f.bookPorts).installPackage(input,id,{scope:cp.scope,has:()=>false,check:async()=>{},commit:async()=>{}});
  const current=(await f.store.readingStates()).find(r=>r.bookId===id&&r.chapterIndex===1)!;expect(current.readingProgress).toBe(.875);expect(current.readingPositionChangedAt).toBe(500);expect(current.readingPositionBytes).toBe(99);expect(current.favoriteSaved).toBe(false);expect(current.favoriteChangedAt).toBe(600);
  const installed=(await f.store.package(id))!,copy=await f.files.writeBytes(f.data.get(installed.path)!);f.data.delete(installed.path);
  await f.store.installPackage(copy,id);expect(await f.store.package(id)).toBeDefined();
 }finally{f.sql.close();}
});
test('RESTOREBOOK source/scope changes never borrow a prior validation receipt',async()=>{
 const f=await bookFixture();try{
  const {id,info}=await original(f,70);let stop=true;const cp=(scope:string)=>({scope:async()=>scope,has:()=>false,check:async()=>{},commit:async()=>{if(stop)throw Error('stop');}});
  await expect(f.store.installPackage(info,id,cp('account-a:epoch-a'))).rejects.toThrow('stop');
  await expect(f.store.installPackage(info,id,cp('account-b:epoch-b'))).rejects.toThrow('stop');
  expect((await f.db.query('SELECT count(*) n FROM sync_book_install'))[0].n).toBe(2);expect((await f.db.query('SELECT count(*) n FROM sync_book_validation'))[0].n).toBe(64);
  stop=false;await f.store.installPackage(info,id,cp('account-b:epoch-b'));expect(await f.store.package(id)).toBeDefined();
 }finally{f.sql.close();}
});
