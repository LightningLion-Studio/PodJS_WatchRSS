/** P3AR appendix A counterexamples, expressed as required product behavior. */
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {engine,ContentBackend,crypt} from './p3-fixture';
import {digest} from '../../src/sync-v2/protocol';
const item={entityKey:'e'.repeat(64),bodyRevision:'f'.repeat(32),kind:'file' as const,importedFile:true,addedAtMillis:1,sourceBinding:'v1'};
const bodyId='body:'+digest([item.entityKey,item.bodyRevision]);
const attempt=async(fn:()=>Promise<any>)=>{try{return await fn();}catch(e){return {error:(e as Error).message};}};
for(const fault of ['recipe-range','blob-range','blob-aead','discard-reply'])test('P3AR R01 '+fault+' discards only bad prefix and automatically resumes after reopen',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-p3-r01-')),b=new ContentBackend(),source=randomBytes(fault==='recipe-range'?100000:400000),sourceCounter={reads:0,bytes:0};let f=engine(root,b,source,{sourceCounter});
 try{await f.store.init();await f.e.enqueue(item,'upload');await f.e.runWindow();const manifest=await f.e.manifest(item.entityKey,item.bodyRevision),uploaded=b.uploaded,sourceReads=sourceCounter.reads,badBlob=(await f.store.get(bodyId))!.value.recipe.blocks[1]?.oid,goodBlob=(await f.store.get(bodyId))!.value.recipe.blocks[0].oid;f.db.close();mkdirSync(join(root,'receiver'));
  let once=true,discardReply=true;const send=b.request,crypto={...crypt,decrypt:async(...a:Parameters<typeof crypt.decrypt>)=>{if(fault==='blob-aead'&&once&&new TextDecoder().decode(a[3]).includes('"type":"blob"')){once=false;throw Error('injected_aead_failure');}return crypt.decrypt(...a);}};
  b.request=async r=>{const response=await send(r);if(fault!=='blob-aead'&&once&&r.method==='GET'&&r.headers.Range&&(fault==='recipe-range'?r.url.includes('/objects/recipe'):decodeURIComponent(r.url).includes(fault==='blob-range'?badBlob:'/objects/blob'))){once=false;const body=response.body.slice();body[body.length-1]^=1;return {...response,body};}return response;};
  f=engine(join(root,'receiver'),b,new Uint8Array(),{crypto});await f.store.init();const {sourceBinding,...base}=item;await f.e.enqueue({...base,...manifest!},'download');f.host.discardHook=()=>{if(fault==='discard-reply'&&discardReply){discardReply=false;throw Error('lost_discard_reply');}};
  const first=await attempt(()=>f.e.runWindow());expect(first.error).toBe(fault==='blob-aead'?'aead_invalid':fault==='discard-reply'?'lost_discard_reply':'hash_mismatch');const saved=(await f.store.get(bodyId))!.value,object=fault==='recipe-range'?saved.recipeObject:saved.object;
  const [stat]=await f.store.files.stat([f.store.path(object.cache)]);expect(stat!.durableOffset).toBe(0);expect(stat!.size).toBe(0);expect(saved.phase).not.toBe('done');const prefix=saved.offset,goodBlobReads=b.calls['/objects/'+goodBlob]??0;if(fault==='blob-range')expect(prefix).toBe(262144);
  b.request=send;const downloaded=b.downloaded;f.db.close();f=engine(join(root,'receiver'),b,new Uint8Array());await f.store.init();const resumed=await attempt(()=>f.e.runWindow());console.info('P3AR_R01',{fault,first:first.error,resume:resumed.error??resumed.status,newDownloadBytes:b.downloaded-downloaded,preservedPlainPrefix:prefix});expect(resumed.status).toBe('complete');expect(b.downloaded).toBeGreaterThan(downloaded);expect(await f.e.readRange(item.entityKey,item.bodyRevision,0,100000)).toEqual(source.subarray(0,100000));if(prefix>0)expect(b.calls['/objects/'+goodBlob]??0).toBe(goodBlobReads);expect(b.uploaded).toBe(uploaded);expect(sourceCounter.reads).toBe(sourceReads);
 }finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});
for(const checkpointLoss of [false,true])test('P3AR R04 replay budget survives '+(checkpointLoss?'pre-PUT checkpoint response loss':'repeated repair ACK loss')+' and reopen',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-p3-r04-')),b=new ContentBackend(),source=randomBytes(200000),send=b.request;let f=engine(root,b,source);
 try{await f.store.init();await f.e.enqueue(item,'upload');b.request=async r=>{const response=await send(r);if(r.url.endsWith('/parts/65536'))f.db.afterCommit=true;return response;};await expect(f.e.runWindow()).rejects.toThrow('injected_after_commit');const id=[...b.partials.keys()][0]!,original=b.partials.get(id)!.slice();expect((await f.store.get(bodyId))!.value.object.confirmedOffset).toBe(131072);f.db.close();const before=b.uploaded;
  b.partials.set(id,original.slice(0,65536));f=engine(root,b,source);await f.store.init();if(checkpointLoss)f.db.afterCommit=true;b.request=async r=>{const v=await send(r);if(r.url.endsWith('/parts/65536'))throw Error('review-lost-repair-ack');return v;};const first=await attempt(()=>f.e.runWindow());f.db.close();
  b.partials.set(id,original.slice(0,65536));f=engine(root,b,source);await f.store.init();const second=await attempt(()=>f.e.runWindow());console.info('P3AR_R04',{checkpointLoss,first:first.error,second:second.error,replayedBytes:b.uploaded-before});expect(second.error).toBe('offset_conflict');expect(b.uploaded-before).toBe(checkpointLoss?0:65536);expect((await f.store.get(bodyId))!.value.object.confirmedOffset).toBe(131072);
 }finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P3AR R04 failed replay transaction sends nothing and does not consume a second budget',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-p3-r04-atomic-')),b=new ContentBackend(),source=randomBytes(200000),send=b.request;let f=engine(root,b,source);
 try{await f.store.init();await f.e.enqueue(item,'upload');b.request=async r=>{const out=await send(r);if(r.url.endsWith('/parts/65536'))f.db.afterCommit=true;return out;};await expect(f.e.runWindow()).rejects.toThrow('injected_after_commit');const id=[...b.partials.keys()][0]!,prefix=b.partials.get(id)!.slice(0,65536),before=b.uploaded;f.db.close();b.partials.set(id,prefix);b.request=send;f=engine(root,b,source);await f.store.init();f.db.crashAt=0;await expect(f.e.runWindow()).rejects.toThrow('injected_crash');expect(b.uploaded).toBe(before);f.db.close();
  f=engine(root,b,source);await f.store.init();b.request=async r=>{const out=await send(r);if(r.url.endsWith('/parts/65536'))throw Error('lost_repair_ack');return out;};await expect(f.e.runWindow()).rejects.toThrow('lost_repair_ack');expect(b.uploaded-before).toBe(65536);f.db.close();b.partials.set(id,prefix);f=engine(root,b,source);await f.store.init();await expect(f.e.runWindow()).rejects.toThrow('offset_conflict');expect(b.uploaded-before).toBe(65536);
 }finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P3AR expired incomplete prefix renews automatically without source reexport',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-p3-expired-')),b=new ContentBackend(),source=randomBytes(200000),counter={reads:0,bytes:0},send=b.request;let f=engine(root,b,source,{sourceCounter:counter});
 try{await f.store.init();await f.e.enqueue(item,'upload');b.losePartAt=1;await expect(f.e.runWindow()).rejects.toThrow('lost_part_response');const id=[...b.partials.keys()][0]!,reserves=b.reserveResponses.size;for(const r of b.reservations.values())r.valid=false;b.clock+=600001;b.request=async r=>{if(r.url.includes('/objects/have-want')&&![...b.reservations.values()].some(v=>v.oid===id&&v.valid!==false))throw Error('reservation_expired');return send(r);};f.db.close();f=engine(root,b,source,{sourceCounter:counter});await f.store.init();expect((await f.e.runWindow()).status).toBe('complete');expect(b.reserveResponses.size).toBeGreaterThan(reserves);expect(b.calls['/objects/'+id+'/parts/0']).toBe(1);expect(counter.reads).toBe(1);
 }finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P3AR R04 uncertain unacknowledged frame also has one cumulative replay allowance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-p3-r04-uncertain-')),b=new ContentBackend(),source=randomBytes(100000),send=b.request;let f=engine(root,b,source);
 try{await f.store.init();await f.e.enqueue(item,'upload');b.losePartAt=1;await expect(f.e.runWindow()).rejects.toThrow('lost_part_response');const id=[...b.partials.keys()][0]!,before=b.uploaded;f.db.close();b.partials.set(id,new Uint8Array());f=engine(root,b,source);await f.store.init();b.request=async r=>{const v=await send(r);if(r.url.endsWith('/parts/0'))throw Error('lost_uncertain_ack');return v;};await expect(f.e.runWindow()).rejects.toThrow('lost_uncertain_ack');f.db.close();b.partials.set(id,new Uint8Array());f=engine(root,b,source);await f.store.init();await expect(f.e.runWindow()).rejects.toThrow('offset_conflict');expect(b.uploaded-before).toBe(65536);
 }finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});
