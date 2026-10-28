import {test,expect} from 'bun:test';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {article,cloudCrypto} from './library-fixture';
import {utf8Encode} from '../../src/cloud/types';
import type {ExportedArticle} from '../../src/sync/article-export';
import type {CloudObject} from '../../src/cloud/codec';
const descriptor=(name:string,privateArticle?:ExportedArticle):CloudObject=>({name,encoding:'identity',originalBytes:0,encodedBytes:0,chunks:[],...(privateArticle?{privateArticle:{...privateArticle}}:{})});
const nameFor=async(a:ExportedArticle)=>`reader/${(await cloudCrypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await cloudCrypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`;
function fixture(rows:ExportedArticle[],options:{guard?:()=>void;sha256?:typeof cloudCrypto.sha256;yieldTurn?:()=>Promise<void>}={}){
 const applied:ExportedArticle[]=[];
 const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[],stateArticles:rows,sources:[]}),mergeCloud:async(_,values)=>{applied.push(...values);return values.length;}},'watch',{...cloudCrypto,...options},{require:()=>options.guard?.()}as any);
 return {adapter,applied};
}
test('2135 candidates and 512 unmatched legacy reader descriptors require linear guarded hash work',async()=>{
 const rows=Array.from({length:2135},(_,i)=>article({articleId:'legacy-'+i,contentHash:'body-'+i}));let calls=0,yields=0;
 const f=fixture(rows,{guard:()=>{if(++calls>20000)throw Error('reader matching work budget exceeded');},yieldTurn:async()=>{yields++;}});
 const wanted=rows.at(-1)!,name=await nameFor(wanted),unknown=Array.from({length:512},(_,i)=>descriptor(`reader/${i.toString(16).padStart(32,'0')}/${'f'.repeat(32)}.txt`));
 const started=performance.now(),result=await f.adapter.restorePayloads(new Map([[name,utf8Encode('restored original')]]),'phone',[...unknown,descriptor(name)]);
 expect(result.abandoned).toBe(512);expect(result.changed).toBe(1);expect(f.applied).toHaveLength(1);expect(f.applied[0]).toMatchObject({articleId:wanted.articleId,contentText:'restored original'});expect(calls).toBeLessThan(20000);expect(yields).toBeGreaterThan(60);expect(performance.now()-started).toBeLessThan(5000);
});
test('legacy payload-only lookup, deleted candidates and duplicate-name first-match order retain their behavior',async()=>{
 const rows=[article({articleId:'deleted',deleted:true}),article({articleId:'first',readingProgress:.75,readingPositionChangedAt:50}),article({articleId:'second'})],name=`reader/${'a'.repeat(32)}/${'a'.repeat(32)}.txt`;
 for(const descriptors of [[],[descriptor(name)]]){
  const f=fixture(rows,{sha256:async()=> 'a'.repeat(64)});const result=await f.adapter.restorePayloads(new Map([[name,utf8Encode('body')],['reader/missing.txt',utf8Encode('unknown')]]),'phone',descriptors);
  expect(f.applied).toHaveLength(1);expect(f.applied[0]).toMatchObject({articleId:'first',readingProgress:.75,readingPositionChangedAt:50,contentText:'body'});expect(result.abandoned).toBe(1);
 }
});
test('modern privateArticle metadata avoids building an unrelated index and preserves its explicit identity',async()=>{
 const rows=Array.from({length:1000},(_,i)=>article({articleId:'modern-'+i,contentHash:'h-'+i}));let hashes=0;
 const f=fixture(rows,{sha256:async bytes=>{hashes++;return cloudCrypto.sha256(bytes);}}),wanted=rows.at(-1)!,name=await nameFor(wanted);
 await f.adapter.restorePayloads(new Map([[name,utf8Encode('body')]]),'phone',[descriptor(name,wanted)]);expect(hashes).toBe(2);expect(f.applied[0].articleId).toBe(wanted.articleId);
});
test('a first legacy match does not evaluate an unrelated failing later candidate',async()=>{
 const first=article({articleId:'healthy'}),later=article({articleId:'unrelated-hash-fault'}),name=await nameFor(first);
 const f=fixture([first,later],{sha256:async bytes=>{if(new TextDecoder().decode(bytes)===later.articleId)throw Error('unrelated hash fault');return cloudCrypto.sha256(bytes);}});
 await f.adapter.restorePayloads(new Map([[name,utf8Encode('body')]]),'phone',[descriptor(name)]);expect(f.applied).toHaveLength(1);expect(f.applied[0].articleId).toBe(first.articleId);
});
test('revocation during index construction commits nothing, and a later restore rebuilds from current metadata',async()=>{
 const rows=Array.from({length:100},(_,i)=>article({articleId:'guard-'+i,contentHash:'h-'+i}));let allowed=true,calls=0;
 const f=fixture(rows,{guard:()=>{if(!allowed||++calls===30){allowed=false;throw Error('cloud_operation_superseded');}}});const name=await nameFor(rows.at(-1)!);
 await expect(f.adapter.restorePayloads(new Map([[name,utf8Encode('body')]]),'phone',[descriptor(name)])).rejects.toThrow('cloud_operation_superseded');expect(f.applied).toEqual([]);
 allowed=true;calls=100;rows.at(-1)!.title='Updated while stopped';await f.adapter.restorePayloads(new Map([[name,utf8Encode('body')]]),'phone',[descriptor(name)]);expect(f.applied[0].title).toBe('Updated while stopped');
});
test('revocation at a yield cannot commit a payload-only match at that boundary',async()=>{
 const rows=Array.from({length:40},(_,i)=>article({articleId:'yield-'+i,contentHash:'h-'+i}));let allowed=true;
 const f=fixture(rows,{guard:()=>{if(!allowed)throw Error('cloud_operation_superseded');},yieldTurn:async()=>{allowed=false;}}),name=await nameFor(rows[31]);
 await expect(f.adapter.restorePayloads(new Map([[name,utf8Encode('body')]]),'phone')).rejects.toThrow('cloud_operation_superseded');expect(f.applied).toEqual([]);
});
