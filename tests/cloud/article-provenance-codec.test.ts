import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {CloudRecordCodec,type RecordRow} from '../../src/cloud/records';
import {readArticleRegisters,articleKnownCanonical,articlePositionStatus} from '../../src/cloud/article-register';
import {cloudCompatibility,cloudRaw,cloudFormatCapabilities} from '../../src/cloud/compatibility';
import {crypto,key} from './k2-crypto';
import {utf8Encode} from '../../src/cloud/types';
const root=process.env.ARTICLE_PROVENANCE_VECTOR_DIR??resolve(import.meta.dir,'fixtures/article-provenance-v1');
const load=(name:string)=>JSON.parse(readFileSync(resolve(root,name),'utf8'));
const manifest=load('manifest.json'),vectors=load('vectors.json'),rejects=load('reject.json');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const codec=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')});
test('article provenance manifest and all imported JSON match the final approved corpus',()=>{
 expect(sha(readFileSync(resolve(root,'manifest.json'),'utf8'))).toBe('b3cf35fa707d3b45d3b703d44e265e77260e18a1a6de2b7b510362423b499830');
 expect(vectors.mergeCases).toHaveLength(159);expect(vectors.normalizationCases).toHaveLength(13);expect(rejects.cases).toHaveLength(42);
 for(const [name,v]of Object.entries(manifest.files) as [string,any][])if(name.endsWith('.json')){const b=readFileSync(resolve(root,name));expect(b.length).toBe(v.sizeBytes);expect(createHash('sha256').update(b).digest('hex')).toBe(v.sha256);}
 expect(cloudFormatCapabilities.cloudArticleProvenanceReadV1).toBe(true);expect(cloudFormatCapabilities.cloudArticleProvenanceWriteV1).toBe(false);
});
for(const v of vectors.mergeCases)test('production six-register merge / '+v.id,async()=>{
 const docs=v.inputs.map((d:any)=>codec.readPlaintext(JSON.stringify(d)));
 for(const sequence of v.orders){const order=sequence.order,steps=[order[1],order[2],...order];let state=docs[order[0]],n=0;
  for(const i of steps){const merged=codec.mergeArticles(state,docs[i]);expect(merged.conflict).toBe(false);state=merged.doc;expect(sha(articleKnownCanonical(state))).toBe(sequence.replayPrefixSha256[n++]);}
  const text=articleKnownCanonical(state);expect(text).toBe(v.expected.canonicalUtf8);expect(Buffer.from(text).toString('hex')).toBe(v.expected.utf8Hex);expect(await codec.hash(state)).toBe(v.expected.sha256);expect(state.value).toEqual(v.expected.record.value);
  expect(articlePositionStatus(state.value)).toBe(v.expected.positionStatus);
  for(const p of ['independent','favorite','watchLater'])expect(state.value[p+'Saved']&&!state.value.deleted).toBe(v.expected.effectiveSaved[p]);
 }
 const left=codec.mergeArticles(codec.mergeArticles(docs[0],docs[1]).doc,docs[2]).doc,right=codec.mergeArticles(docs[0],codec.mergeArticles(docs[1],docs[2]).doc).doc;
 expect(articleKnownCanonical(left)).toBe(articleKnownCanonical(right));
});
async function sealed(bytes:Uint8Array):Promise<RecordRow>{
 const base=vectors.mergeCases[0].inputs[0],id=await codec.id(key,'user',{kind:'article',value:base.value,features:base.features}),derived=await crypto.hkdf(key,utf8Encode('user'),utf8Encode('watchrss/cloud/record/v1'));
 try{const e=await crypto.encrypt(derived,utf8Encode(`watchrss-cloud-record-v1:user:${id}:1`),bytes);return {recordId:id,revision:'1',tombstone:false,envelope:{algorithm:'A256GCM',keyVersion:1,nonceBase64:Buffer.from(e.nonce).toString('base64'),ciphertextBase64:Buffer.from(e.ciphertext).toString('base64')}};}finally{derived.fill(0);}
}
for(const v of vectors.normalizationCases)test('production normalization / '+v.id,async()=>{
 const doc=v.mode==='legacySeed'?readArticleRegisters(v.raw,true):(await codec.decode(key,key,'user',await sealed(utf8Encode(v.raw)))).doc;
 expect(articleKnownCanonical(doc)).toBe(v.expected.canonicalUtf8);expect(Buffer.from(articleKnownCanonical(doc)).toString('hex')).toBe(v.expected.utf8Hex);expect(await codec.hash(doc)).toBe(v.expected.sha256);expect(doc.value).toEqual(v.expected.record.value);
});
for(const v of rejects.cases)test('production rejection or raw isolation / '+v.id,async()=>{
 if(v.mode==='merge'){expect(()=>codec.mergeArticles(codec.readPlaintext(JSON.stringify(v.left)),codec.readPlaintext(JSON.stringify(v.right)))).toThrow();return;}
 if(v.mode==='legacySeed'){expect(()=>readArticleRegisters(v.raw,true)).toThrow();return;}
 const row=await sealed(v.rawHex?new Uint8Array(Buffer.from(v.rawHex,'hex')):utf8Encode(v.raw));
 if(['opaque_feature','read_only_feature'].includes(v.error)){const doc=(await codec.decode(key,key,'user',row)).doc;expect(cloudCompatibility(doc).readOnly).toBe(true);expect(cloudCompatibility(doc).opaque).toBe(v.error==='opaque_feature');expect(cloudRaw(doc)?.source).toBe(v.raw);}
 else await expect(codec.decode(key,key,'user',row)).rejects.toThrow();
});
test('accepted provenance is readable, retains raw extension tokens and is never encrypted by this reader build',async()=>{
 const raw=JSON.stringify(vectors.mergeCases[0].inputs[0]).replace('"value":{','"futureRoot": {"n":9007199254740993},"value":{"futureValue": {"s":"\\u4e2d","n":1.0000000000000001},');
 const row=await sealed(utf8Encode(raw)),doc=(await codec.decode(key,key,'user',row)).doc;
 expect(cloudRaw(doc)?.source).toBe(raw);expect(cloudCompatibility(doc).readOnly).toBe(true);
 const merged=codec.mergeArticles(doc,doc);expect(merged.conflict).toBe(false);expect(cloudRaw(merged.doc)?.source).toContain('"futureValue": {"s":"\\u4e2d","n":1.0000000000000001}');
 const other=(await codec.decode(key,key,'user',await sealed(utf8Encode(raw.replace('9007199254740993','9007199254740994'))))).doc;
 expect(codec.mergeArticles(doc,other).conflict).toBe(true);
 await expect(codec.encode(key,'user',row.recordId,1,doc)).rejects.toThrow('cloud_format_read_only');
});
test('progress bounds inspect original tokens before binary64 rounding or underflow',()=>{
 const base=JSON.stringify(vectors.mergeCases[0].inputs[0]);
 for(const token of ['1.0000000000000001','-1e-999999'])expect(()=>codec.readPlaintext(base.replace('"readingProgress":0','"readingProgress":'+token))).toThrow();
 for(const token of ['1e-999999','-0','1.0000000000000000'])expect(codec.readPlaintext(base.replace('"readingProgress":0','"readingProgress":'+token)).value.readingProgress).toBe(Number(token)||0);
});
