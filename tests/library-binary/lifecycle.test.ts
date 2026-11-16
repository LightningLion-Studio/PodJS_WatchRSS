import {test,expect} from 'bun:test';
import {JobLifecycle,type JobJournal} from '../../src/sync/library-binary/lifecycle';
import {Grant} from '../../src/sync/library-binary/state';
import {pageDigest,receiptsRoot} from '../../src/sync/library-binary/digests';
import {type AppliedReceipt} from '../../src/sync/library-binary/wire';
import {begin,binding,object,request} from './helpers';
function fixture(){
 const o=object('rssSource'),b=begin([o]),grant=new Grant('c',1),receipts:AppliedReceipt[]=[],events:string[]=[];
 const journal:JobJournal={manifestPage:async(_i,_e,check)=>{check();events.push('page');},verifyAndReservePeak:async check=>{check();events.push('reserve');},apply:async(_id,make,check)=>{check();if(receipts.length)return receipts[0]!;const r=make('merged');receipts.push(r);events.push('apply');return r;},receipts:async()=>[...receipts],complete:async(_v,check)=>{check();events.push('complete');},cancel:async()=>{events.push('cancel');}};
 const life=new JobLifecycle(binding.jobId,b.payload,grant,journal,'watch'),req=(phase:Parameters<typeof request>[0],p:Record<string,unknown>)=>request(phase,p,{planDigest:b.plan});
 const page=req('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(b.plan,0,0,[o],'0'.repeat(64)),entries:[o]});return {o,b,grant,receipts,events,journal,life,req,page};
}
test('manifest root/peak gate precedes size-zero APPLIED and real complete receipt',async()=>{
 const f=fixture();await expect(f.life.apply(f.req('apply',{objectId:f.o.objectId}))).rejects.toThrow('MANIFEST_INCOMPLETE');
 expect((await f.life.manifest(f.page)).manifestVerified).toBe(true);expect(f.events).toEqual(['page','reserve']);expect(await f.life.manifest(f.page)).toMatchObject({manifestVerified:true});expect(f.events.length).toBe(2);
 const apply=f.req('apply',{objectId:f.o.objectId});expect((await f.life.apply(apply)).state).toBe('APPLIED');await f.life.apply(apply);expect(f.events.filter(e=>e==='apply').length).toBe(1);
 const finish=f.req('complete',{objectCount:1,receiptsRoot:receiptsRoot(f.receipts),ackToInclusive:0});const done=await f.life.finish(finish);expect(done.state).toBe('COMPLETE');expect(await f.life.finish(finish)).toEqual(done);expect(f.events.filter(e=>e==='complete').length).toBe(1);
 expect(await f.life.cancel(f.req('cancel',{reason:'USER_CANCEL'}))).toEqual({state:'COMPLETE',alreadyComplete:true});
});
test('wrong root/page/order or missing peak reservation never reaches READY',async()=>{
 for(const mutate of ['root','page','start','peak']){const f=fixture();if(mutate==='root')f.b.payload.objectsRoot='f'.repeat(64);
  if(mutate==='peak')f.journal.verifyAndReservePeak=async()=>{throw Error('STORAGE_PRESSURE');};
  const p={...f.page.payload};if(mutate==='page')p.pageDigest='f'.repeat(64);if(mutate==='start')p.startIndex=1;
  const life=mutate==='root'?new JobLifecycle(binding.jobId,f.b.payload,f.grant,f.journal,'watch'):f.life;
  await expect(life.manifest(f.req('manifestPage',p))).rejects.toThrow();expect(life.snapshot.manifestVerified).toBe(false);
 }
});
test('empty plan reserves zero objects; cancel fences old asynchronous commits',async()=>{
 const f=fixture(),b=begin([]),life=new JobLifecycle(binding.jobId,b.payload,f.grant,f.journal,'watch');await life.emptyPlan();expect(life.snapshot.state).toBe('READY');
 const g=fixture();expect(await g.life.cancel(g.req('cancel',{reason:'USER_CANCEL'}))).toEqual({state:'CANCELLED',alreadyComplete:false});await expect(g.life.manifest(g.page)).rejects.toThrow('AUTH_REVOKED');
});
test('reopen journal after lost reply reuses actual durable receipt; no second business merge',async()=>{
 const f=fixture();await f.life.manifest(f.page);const apply=f.req('apply',{objectId:f.o.objectId});const first=await f.life.apply(apply);
 f.grant.fence();const grant=new Grant('new',2),resume=new JobLifecycle(binding.jobId,{...f.b.payload,intent:'resume'},grant,f.journal,'watch');
 const page={...f.page,epoch:2};await resume.manifest(page);expect(await resume.apply({...apply,epoch:2})).toEqual(first);expect(f.events.filter(x=>x==='apply').length).toBe(1);
});
test('durable checkpoint resumes PLANNING at next page and revalidates READY peak reservation',async()=>{
 const f=fixture();await f.life.manifest(f.page);const checkpoint=f.life.checkpoint();f.grant.fence();const grant=new Grant('new',2),life=new JobLifecycle(binding.jobId,f.b.payload,grant,f.journal,'watch');
 await life.restore(checkpoint);expect(life.snapshot).toMatchObject({state:'READY',nextManifestPage:1});expect(f.events.filter(x=>x==='reserve').length).toBe(2);expect(await life.manifest({...f.page,epoch:2})).toMatchObject({manifestVerified:true});
 const corrupt={...checkpoint,planDigest:'f'.repeat(64)};await expect(new JobLifecycle(binding.jobId,f.b.payload,new Grant('bad',3),f.journal,'watch').restore(corrupt)).rejects.toThrow('JOURNAL_CORRUPT');
});
test('PLANNING partial manifest resume keeps nextManifestPage and original frozen plan',async()=>{
 const f=fixture(),a=f.o,other={...object('rssSource'),businessId:'second'};const {objectId,planDigest}=await import('../../src/sync/library-binary/digests');other.objectId=objectId(other);
 const objects=[a,other].sort((a,b)=>a.objectId<b.objectId?-1:1),b=begin(objects);b.payload.pageObjectCounts=[1,1];const plan=planDigest(b.payload),life=new JobLifecycle(binding.jobId,b.payload,f.grant,f.journal,'watch');
 const first=request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(plan,0,0,[objects[0]!],'0'.repeat(64)),entries:[objects[0]!]},{planDigest:plan});await life.manifest(first);expect(life.snapshot).toMatchObject({state:'PLANNING',nextManifestPage:1});expect(f.events).toEqual(['page']);
 const checkpoint=life.checkpoint();f.grant.fence();const resumed=new JobLifecycle(binding.jobId,{...b.payload,intent:'resume'},new Grant('new',2),f.journal,'watch');await resumed.restore(checkpoint);expect(resumed.snapshot).toMatchObject({state:'PLANNING',nextManifestPage:1});expect(f.events).toEqual(['page']);
 const second=request('manifestPage',{pageIndex:1,startIndex:1,previousPageDigest:first.payload!.pageDigest,pageDigest:pageDigest(plan,1,1,[objects[1]!],String(first.payload!.pageDigest)),entries:[objects[1]!]},{planDigest:plan,epoch:2});await resumed.manifest(second);expect(resumed.snapshot.state).toBe('READY');expect(f.events).toEqual(['page','page','reserve']);
});
test('manifest replay allows JSON key reordering while preserving raw metadata bytes',async()=>{
 const f=fixture();await f.life.manifest(f.page);const entries=[Object.fromEntries(Object.entries(f.o).reverse())],payload=Object.fromEntries(Object.entries({...f.page.payload,entries}).reverse());
 expect(await f.life.manifest({...f.page,payload})).toMatchObject({manifestVerified:true});expect(f.events).toEqual(['page','reserve']);
});
test('manifest admission counts raw CONTROL bytes, including ignored JSON whitespace',async()=>{
 const f=fixture(),{selectionDigest,planDigest}=await import('../../src/sync/library-binary/digests'),{encodeFrame,decodeFrame}=await import('../../src/sync/library-binary/codec');
 f.b.payload.selection={...f.b.payload.selection,limits:{...f.b.payload.selection.limits,maxManifestPageBytes:2048}};f.b.payload.selectionDigest=selectionDigest(f.b.payload.selection);const plan=planDigest(f.b.payload);
 const r=request('manifestPage',{...f.page.payload,pageDigest:pageDigest(plan,0,0,[f.o],'0'.repeat(64))},{planDigest:plan}),original=encodeFrame({kind:'control',envelope:r}),raw=new Uint8Array(original.length+2048);raw.set(original.subarray(0,16));raw.fill(32,16,2064);raw.set(original.subarray(16),2064);const v=new DataView(raw.buffer);v.setUint32(0,raw.length-4);v.setUint32(12,raw.length-16);
 const decoded=decodeFrame(raw);if(decoded.kind!=='control')throw Error('wrong fixture');const life=new JobLifecycle(binding.jobId,f.b.payload,f.grant,f.journal,'watch');await expect(life.manifest(decoded.envelope)).rejects.toThrow('LIMIT_EXCEEDED');expect(f.events).toEqual([]);
});
