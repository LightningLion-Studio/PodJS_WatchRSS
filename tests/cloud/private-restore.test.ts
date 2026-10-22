import {test,expect} from 'bun:test';
import fixture from './fixtures/private-archive-v3.json';
import {dbFixture,cloudCrypto,article} from './library-fixture';
import {fixture as serviceFixture} from './service-fixture';
import {crypto,key} from './k2-crypto';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {readWrss,writeWrss} from '../../src/cloud/wrss';
import type {CloudObject} from '../../src/cloud/codec';
const archive=()=>new Uint8Array(Buffer.from(fixture.wrssBase64,'base64'));
const descriptor={...fixture.reader,encoding:'identity',originalBytes:0,encodedBytes:0,chunks:[]} as CloudObject;
test('R31/R39 writer keeps saved RSS archive shape and writes article records only for private imports',async()=>{
 const f=await dbFixture();try{await f.repo.mergeCloud([], [{...article(),...fixture.article,contentText:fixture.text,contentHtml:null}], 'phone');const out=await f.adapter.exportPayloads(true),zip=await readWrss(out.objects[0].bytes,crypto.gunzip),row=JSON.parse(utf8Decode(zip.get('articles.json')!))[0];
  for(const field of ['articleId','url','title','rssSourceUrl','rssSourceTitle','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder'])expect(row[field]).toEqual((fixture.article as any)[field]);
  expect(row.importedAt).toBeGreaterThanOrEqual(fixture.article.importedAt);await f.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/import'),url:'https://private.example/import'})], 'phone');expect((await f.adapter.exportRecords()).filter(d=>d.kind==='article')).toHaveLength(1);
 }finally{f.sql.close();}
});
for(const format of ['phone WRSS','mini reader'] as const)test(`R31/R32 empty library restores ${format} identity, original and saves with no article records or public entries`,async()=>{
 const f=await dbFixture();try{const p=format==='phone WRSS'?new Map([['private-library.wrss',archive()]]):new Map([[descriptor.name,utf8Encode(fixture.text)]]),restored=await f.adapter.restorePayloads(p,'phone',format==='mini reader'?[descriptor]:[]);expect(restored.pending).toBe(0);expect(restored.changed).toBeGreaterThan(0);const rows=(await f.repo.cloudSnapshot(true)).articles;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({articleId:fixture.article.articleId,title:fixture.article.title,url:fixture.article.url,rssSourceUrl:fixture.article.rssSourceUrl,contentText:fixture.text,favoriteSaved:true,favoriteChangedAt:150,watchLaterSaved:true,watchLaterChangedAt:160});
 }finally{f.sql.close();}
});
test('R32 one WRSS item missing metadata/body does not block healthy items and remains retryable',async()=>{
 const f=await dbFixture();try{const zip=await readWrss(archive(),crypto.gunzip),rows=JSON.parse(utf8Decode(zip.get('articles.json')!));const second={...rows[0],articleId:await cloudCrypto.stableId('https://news.example/second'),url:'https://news.example/second',title:'Second'};const stem='bodies/'+await crypto.sha256(utf8Encode(second.articleId));second.contentTextEntry=stem+'.txt';rows.push(second,{articleId:'missing-metadata'});zip.set('articles.json',utf8Encode(JSON.stringify(rows)));let r=await f.adapter.restorePayloads(new Map([['private-library.wrss',writeWrss(zip)]]),'phone');expect(r.pending).toBe(0);expect(r.abandoned).toBe(2);expect(r.warnings).toHaveLength(2);expect((await f.repo.cloudSnapshot(true)).articles).toHaveLength(1);
  rows.pop();zip.set('articles.json',utf8Encode(JSON.stringify(rows)));zip.set(second.contentTextEntry,utf8Encode('Second original'));r=await f.adapter.restorePayloads(new Map([['private-library.wrss',writeWrss(zip)]]),'phone');expect(r.pending).toBe(0);expect((await f.repo.cloudSnapshot(true)).articles).toHaveLength(2);
 }finally{f.sql.close();}
});
test('R32 legacy content-only archive without baseline warns rather than silently applying; matching legacy baseline can retry',async()=>{
 const f=await dbFixture();try{const zip=await readWrss(archive(),crypto.gunzip),rows=JSON.parse(utf8Decode(zip.get('articles.json')!));rows[0].url='';rows[0].title='';zip.set('articles.json',utf8Encode(JSON.stringify(rows)));const p=new Map([['private-library.wrss',writeWrss(zip)]]);expect((await f.adapter.restorePayloads(p,'phone')).abandoned).toBe(1);expect((await f.repo.cloudSnapshot(true)).articles).toHaveLength(0);
  await f.repo.mergeCloud([], [{...article(),...fixture.article,contentText:fixture.text,contentHtml:null}], 'phone');expect((await f.adapter.restorePayloads(p,'phone')).pending).toBe(0);
 }finally{f.sql.close();}
});
test('R32 missing reader body/identity/hash/path warns; healthy descriptor survives and newer reading state wins archive baseline',async()=>{
 const f=await dbFixture();try{const sourceId=await (await import('../../src/cloud/rss-identity')).rssSourceKey(fixture.article.rssSourceUrl,crypto.sha256);await f.adapter.applyRecords([{kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(fixture.article.articleId)),sourceDeviceId:'z',isRead:true,readingPositionChangedAt:200,readingProgress:.8,favoriteSaved:false,favoriteChangedAt:201,watchLaterSaved:true,watchLaterChangedAt:202}}]);
  const p=new Map([[descriptor.name,utf8Encode(fixture.text)]]);const r=await f.adapter.restorePayloads(p,'phone',[descriptor,{...descriptor,name:'reader/missing.txt'},{...descriptor,name:'reader/wrong.txt',privateArticle:undefined}]);expect(r.pending).toBe(0);expect(r.abandoned).toBe(2);const restored=(await f.repo.cloudSnapshot(true)).articles[0];expect(restored.isRead).toBe(true);expect(restored.favoriteSaved).toBe(false);expect(restored.watchLaterSaved).toBe(true);expect(restored.readingProgress).toBeCloseTo(.8);
  expect((await f.adapter.restorePayloads(p,'phone',[{...descriptor,contentSha256:'0'.repeat(64)}])).abandoned).toBe(1);
 }finally{f.sql.close();}
});
test('R32 authenticated head with missing body does not advance applied or ACK; retry completes and preserves healthy items',async()=>{
 const f=await serviceFixture(),db=await dbFixture();try{f.session.library=db.adapter;const two={...fixture.article,articleId:await cloudCrypto.stableId('https://news.example/second'),url:'https://news.example/second',title:'Second'},name=`reader/${(await crypto.sha256(utf8Encode(two.articleId))).slice(0,32)}/${(await crypto.sha256(utf8Encode(two.contentHash))).slice(0,32)}.txt`;
  const {snap,head}=await f.phone({objects:[{name:descriptor.name,bytes:utf8Encode(fixture.text),privateArticle:fixture.article,contentSha256:fixture.reader.contentSha256},{name,bytes:utf8Encode('Second original'),privateArticle:two}]});const missing=snap.manifest.objects[1].chunks[0].ciphertextSha256,saved=f.objects.get(missing)!;f.objects.delete(missing);
  expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.message).toContain('等待重试');expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.filter(c=>c.url.includes('/'+head.id+'/ack'))).toHaveLength(0);expect((await db.repo.cloudSnapshot(true)).articles).toHaveLength(1);
  f.objects.set(missing,saved);expect(await f.service.syncNow(true)).toBe(true);expect(await f.state.applied('phone',true)).toBe(head.deviceSequence);expect(f.calls.some(c=>c.url.includes('/'+head.id+'/ack'))).toBe(true);expect((await db.repo.cloudSnapshot(true)).articles).toHaveLength(2);
 }finally{db.sql.close();}
});
test('R32 archive missing its metadata directory does not prevent a healthy reader item from restoring',async()=>{
 const f=await dbFixture();try{const zip=await readWrss(archive(),crypto.gunzip);zip.delete('articles.json');const r=await f.adapter.restorePayloads(new Map([['private-library.wrss',writeWrss(zip)],[descriptor.name,utf8Encode(fixture.text)]]),'phone',[descriptor]);expect(r.pending).toBe(0);expect(r.abandoned).toBe(1);expect((await f.repo.cloudSnapshot(true)).articles[0].contentText).toBe(fixture.text);
 }finally{f.sql.close();}
});
test('R32 records failure cannot hide a pending-body warning or let a skipped head advance',async()=>{
 const f=await serviceFixture(),db=await dbFixture();try{f.session.library=db.adapter;f.session.records=async()=>{throw Error('records offline');};const {head,snap}=await f.phone({objects:[{name:descriptor.name,bytes:utf8Encode(fixture.text),privateArticle:fixture.article}]});f.objects.delete(snap.manifest.objects[0].chunks[0].ciphertextSha256);expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.message).toContain('云记录待重试');expect(f.service.status.message).toContain('缺少元数据或正文');expect(f.service.status.pendingItems).toBe(1);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(c=>c.url.includes('/'+head.id+'/ack'))).toBe(false);
 }finally{db.sql.close();}
});
test('R38 temporary host decompression failure remains retryable rather than abandoning an authenticated archive',async()=>{
 const {WatchCloudLibraryAdapter}=await import('../../src/cloud/library');const f=await dbFixture();try{let unavailable=true;const a=new WatchCloudLibraryAdapter(f.repo,'watch',{...cloudCrypto,gunzip:async(b,max)=>{if(unavailable)throw Error('temporary host storage unavailable');return crypto.gunzip(b,max);}},(await import('./k2-crypto')).enabled),payload=new Map([['private-library.wrss',archive()]]);let r=await a.restorePayloads(payload,'phone');expect(r.pending).toBe(1);expect(r.abandoned).toBe(0);unavailable=false;r=await a.restorePayloads(payload,'phone');expect(r.pending).toBe(0);expect((await f.repo.cloudSnapshot(true)).articles).toHaveLength(1);
 }finally{f.sql.close();}
});
