import {test,expect} from 'bun:test';
import {readFileSync,existsSync} from 'node:fs';
import endToEnd from './fixtures/rss-state-e2e-v1.json';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {article} from './library-fixture';
import {enabled} from './k2-crypto';
import sources from './fixtures/rss-source-key.json';
import state from './fixtures/rss-state-v1.json';
import anchor from './fixtures/rss-state-anchor-v1.json';
import {canonicalRssUrl,rssSourceKey,rssArticleId,legacyWebArticleId} from '../../src/cloud/rss-identity';
import {CloudRecordCodec,canonical} from '../../src/cloud/records';
import {crypto} from './k2-crypto';
import {createHmac,createCipheriv,createHash} from 'node:crypto';
import {utf8Encode} from '../../src/cloud/types';
test('R30 source URL, backend source_key and public article IDs match the shared vectors',async()=>{
 for(const v of sources.sourceCases){expect(canonicalRssUrl(v.input)).toBe(v.canonicalUrl);expect(await rssSourceKey(v.input,crypto.sha256)).toBe(v.sourceKey);}
 for(const v of sources.rejectedSources)expect(()=>canonicalRssUrl(v.input)).toThrow();
 for(const v of sources.legacyWebArticleCases)expect(await legacyWebArticleId(v.input,crypto.sha256)).toBe(v.articleId);
 for(const v of sources.articleCases){const id=await rssArticleId({link:v.input,guid:v.guid,contentHash:v.contentHash,title:v.title},crypto.sha256);expect(id).toBe(v.articleId);expect(await crypto.sha256(utf8Encode(id))).toBe(v.articleIdHash);}
});
test('rss-state-v1 and rss-state-anchor-v1 shared JSON match anchored IDs, plaintext, AAD and exact ciphertext',async()=>{
 for(const v of [state,anchor,endToEnd]){const a='anchorKeyHex'in v?v.anchorKeyHex:v.accountKeyHex,k='contentKeyHex'in v?v.contentKeyHex:v.accountKeyHex,nonce=Buffer.from(v.envelope.nonceBase64,'base64'),version=v.envelope.keyVersion;
  const c=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex'),encrypt:async(k,a,b)=>{const c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(b),c.final(),c.getAuthTag()]))};}}),ak=new Uint8Array(Buffer.from(a,'hex')),ck=new Uint8Array(Buffer.from(k,'hex')),d={kind:'rss-state',value:v.value};
  expect(await c.id(ak,v.userId,d)).toBe(v.recordId);expect(canonical({format:'watchrss-rss-record',version:1,...d})).toBe(v.plaintextUtf8);expect(v.aad).toBe(`watchrss-cloud-record-v1:${v.userId}:${v.recordId}:${version}`);expect(await c.encode(ck,v.userId,v.recordId,version,d)).toEqual(v.envelope as any);expect((await c.decode(ck,ak,v.userId,{recordId:v.recordId,revision:'1',tombstone:false,envelope:v.envelope as any})).doc).toEqual(d);
 }
});
test('checked-in vector fixtures are byte-identical to central vectors when the shared review workspace exists',()=>{
 for(const name of ['rss-source-key.json','rss-state-v1.json','rss-state-anchor-v1.json','rss-state-e2e-v1.json']){const shared=new URL('../../../.codex-tmp/cloud-v2/vectors/'+name,import.meta.url);if(existsSync(shared))expect(createHash('sha256').update(readFileSync(new URL('./fixtures/'+name,import.meta.url))).digest('hex')).toBe(createHash('sha256').update(readFileSync(shared)).digest('hex'));}
});

test('R37 feed and raw local entry through production projection match the shared end-to-end record identity and full encrypted envelope',async()=>{
 const v=endToEnd,sourceId=await rssSourceKey(v.feed.input,crypto.sha256),articleId=await rssArticleId(v.entry.input,crypto.sha256);expect(sourceId).toBe(v.feed.sourceKey);expect(articleId).toBe(v.entry.articleId);
 const row=article({...v.value,articleId:'old-local-identity',url:v.entry.input,rssSourceUrl:v.feed.input,independentSaved:false});
 const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[row],stateArticles:[row],sources:[]}),mergeCloud:async()=>0},'watch',{...crypto,stableId:url=>rssArticleId(url,crypto.sha256)},enabled),doc=(await adapter.exportRecords())[0];expect(doc).toEqual({kind:v.kind,value:v.value});
 const nonce=Buffer.from(v.nonceHex,'hex'),ak=new Uint8Array(Buffer.from(v.anchorKeyHex,'hex')),ck=new Uint8Array(Buffer.from(v.contentKeyHex,'hex')),codec=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex'),encrypt:async(k,a,b)=>{const c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(b),c.final(),c.getAuthTag()]))};}});expect(await codec.id(ak,v.userId,doc)).toBe(v.recordId);expect(v.recordIdentityUtf8).toBe(`rss-state:${sourceId}:${doc.value.articleIdHash}`);expect(canonical({format:'watchrss-rss-record',version:1,...doc})).toBe(v.plaintextUtf8);expect(await codec.encode(ck,v.userId,v.recordId,v.keyVersion,doc)).toEqual(v.envelope as any);
});
