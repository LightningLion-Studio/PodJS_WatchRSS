import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import source from '../fixtures/library-binary/SOURCE.json';
import {Preparation} from '../../src/sync/library-binary/prepare';
import {Grant,ReceiveWindow,SendWindow,negativeReply} from '../../src/sync/library-binary/state';
import {s2Capability} from '../../src/sync/library-binary/routing';
import {planDigest,preparationDigest,selectionDigest,requestDigest} from '../../src/sync/library-binary/digests';
import {missingPage,type MissingIndex} from '../../src/sync/library-binary/missing';
import {ResumeError,hash,type BeginPayload,type Direction} from '../../src/sync/library-binary/wire';
import {begin,binding,object,request,data} from './helpers';

async function prepared(intent:'create'|'resume'='create',twoJobs=false){
 const o=object(),b:BeginPayload={...begin([o]).payload,intent},cap=s2Capability(b.selection.kinds.map(k=>({...k,send:true,receive:true})),b.selection.limits),prep=new Preparation(cap);
 const offered=await prep.offerRequest('a'.repeat(32),{step:'offer',accountScope:b.accountScope,phoneDeviceId:b.phoneDeviceId,watchDeviceId:b.watchDeviceId,phoneCapabilities:cap,phoneSnapshot:b.phoneSnapshot,watchSnapshot:null},b.watchSnapshot,async()=>{});
 const bs=[{direction:'phoneToWatch' as Direction,jobId:binding.jobId,intent,selection:b.selection}];if(twoJobs)bs.push({direction:'watchToPhone',jobId:'ab'.repeat(16),intent,selection:b.selection});
 await prep.confirmRequest({step:'confirm',offerRequestId:'a'.repeat(32),bindings:bs,preparationDigest:preparationDigest(String(offered.offerDigest),bs)},async()=>{});prep.confirmResponseFullyWritten();
 const make=(p:BeginPayload=b,jobId=binding.jobId)=>request('begin',p as unknown as Record<string,unknown>,{jobId,planDigest:planDigest(p)});
 return {prep,b,o,make};
}
for(const intent of ['create','resume'] as const)test('RVB2S2-03 first begin strictly matches confirm '+intent,async()=>{
 const {prep,b,make}=await prepared(intent),wrong={...b,intent:intent==='create'?'resume' as const:'create' as const};
 expect(()=>prep.authorizeBegin(make(wrong))).toThrow('PLAN_CONFLICT');expect(prep.authorizeBegin(make()).intent).toBe(intent);
 const resume=make({...b,intent:'resume'});expect(prep.authorizeBegin(resume).intent).toBe('resume');expect(prep.authorizeBegin(resume).intent).toBe('resume');
});
test('RVB2S2-03 create → LEASE_EXPIRED → resume → regrant → missing → epoch 2 DATA/ACK',async()=>{
 const {prep,b,o,make}=await prepared();prep.authorizeBegin(make());const plan=planDigest(b),bound={...binding,planDigest:plan,selectionDigest:b.selectionDigest};
 const grant=new Grant('same-physical',1),oldToken=grant.token(),receive=new ReceiveWindow(bound,grant,{objectCount:1,at:async()=>o}),send=new SendWindow(bound,1);receive.admit();
 const input={...data(),requestDigest:requestDigest(bound.jobId,plan,'putChunk',{objectId:o.objectId,chunkIndex:0})},first=send.reserve(input);let commits=0,acks=0;
 const store={commit:async(_f:unknown,_o:unknown,check:()=>void)=>{check();commits++;return 1 as const;}};
 await expect(receive.receive(first,store,async()=>{acks++;},new ResumeError('LEASE_EXPIRED'))).rejects.toThrow('LEASE_EXPIRED');
 expect(send.negative(negativeReply(bound,first,new ResumeError('LEASE_EXPIRED')),0)!.action).toBe('BEGIN');expect(send.credit.bytes).toBe(0);
 const resumed=make({...b,intent:'resume'});expect(resumed.requestId).not.toBe(first.requestId);expect(prep.authorizeBegin(resumed).intent).toBe('resume');
 receive.regrant(2);send.regrant(2);expect(()=>grant.check(oldToken)).toThrow('AUTH_REVOKED');
 const index:MissingIndex={objectCount:1,locate:async()=>0,at:async()=>o,receipt:async()=>null,readChunk:async()=>null,objectStaged:async()=>false};
 const missing=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:1},{planDigest:plan,epoch:2});
 expect((await missingPage(missing,bound,grant,b.selection,index,{state:'READY',nextManifestPage:1,expiresAtMillis:60000,completion:null,admitted:true})).items).toMatchObject([{missingRanges:[[0,1]]}]);
 receive.admit();const retry=send.reserve(input);expect(retry).toMatchObject({epoch:2,txSeq:1,requestId:first.requestId,requestDigest:first.requestDigest});
 await receive.receive(retry,store,async ack=>{acks++;expect(ack).toMatchObject({epoch:2,ackSeq:1,entries:[{txSeq:1,disposition:1}]});send.acceptAck(ack,0);});expect({commits,acks}).toEqual({commits:1,acks:1});expect(send.credit).toEqual({chunks:0,bytes:0});
});
test('RVB2S2-03 resume cannot replace the first plan, selection, snapshots or job',async()=>{
 const {prep,b,make}=await prepared();prep.authorizeBegin(make());
 const selection={...b.selection,limits:{...b.selection.limits,maxObjectBytes:8388608}};
 const changes:BeginPayload[]=[{...b,objectsRoot:'f'.repeat(64)},{...b,selection,selectionDigest:selectionDigest(selection)},{...b,phoneSnapshot:{...b.phoneSnapshot,snapshotId:'different'}},{...b,watchSnapshot:{...b.watchSnapshot,manifestDigest:'f'.repeat(64)}}];
 for(const p of changes)expect(()=>prep.authorizeBegin(make({...p,intent:'resume'}))).toThrow('PLAN_CONFLICT');
 expect(()=>prep.authorizeBegin(make({...b,intent:'resume'},'ff'.repeat(16)))).toThrow('PLAN_CONFLICT');expect(prep.authorizeBegin(make({...b,intent:'resume'})).intent).toBe('resume');
});
test('RVB2S2-03 first intent and frozen plan are per binding and per physical preparation',async()=>{
 const {prep,b,make}=await prepared('create',true);prep.authorizeBegin(make());const reverse={...b,direction:'watchToPhone' as const};
 expect(()=>prep.authorizeBegin(make({...reverse,intent:'resume'},'ab'.repeat(16)))).toThrow('PLAN_CONFLICT');prep.authorizeBegin(make(reverse,'ab'.repeat(16)));expect(prep.authorizeBegin(make({...reverse,intent:'resume'},'ab'.repeat(16))).intent).toBe('resume');
 const fresh=await prepared();expect(()=>fresh.prep.authorizeBegin(fresh.make({...fresh.b,intent:'resume'}))).toThrow('PLAN_CONFLICT');
});
function windowAt(epoch:number){
 const grant=new Grant('physical-'+epoch,epoch),o=object();let reads=0,commits=0,acks=0;
 const receive=new ReceiveWindow(binding,grant,{objectCount:1,at:async()=>{reads++;return o;}});receive.admit();
 const frame={...data(),epoch,requestDigest:requestDigest(binding.jobId,binding.planDigest,'putChunk',{objectId:o.objectId,chunkIndex:0})};
 const store={commit:async(_f:unknown,_o:unknown,check:()=>void)=>{check();commits++;return 1 as const;}},emit=async()=>{acks++;};
 return {grant,receive,frame,store,emit,counts:()=>({reads,commits,acks})};
}
for(const epoch of [1,3])test('RVB2S2-04 fresh connection first epoch 2 rejects '+epoch+' with STALE_EPOCH/STOP',async()=>{
 const f=windowAt(2),token=f.grant.token();let error:ResumeError|undefined;
 try{await f.receive.receive({...f.frame,epoch},f.store,f.emit);}catch(e){error=e as ResumeError;}
 expect(error?.code).toBe('STALE_EPOCH');expect(error?.wire().recovery).toBe('STOP');expect(()=>f.grant.check(token)).toThrow('AUTH_REVOKED');expect(f.counts()).toEqual({reads:0,commits:0,acks:0});
});
test('RVB2S2-04 same connection grants 1→2: discard old 1, then accept new 2 txSeq 1',async()=>{
 const f=windowAt(1);f.receive.regrant(2);expect(await f.receive.receive(f.frame,f.store,f.emit)).toBe('STALE');expect(f.counts()).toEqual({reads:0,commits:0,acks:0});f.receive.admit();expect(await f.receive.receive({...f.frame,epoch:2},f.store,f.emit)).toBe('ACK');expect(f.counts()).toEqual({reads:1,commits:1,acks:1});
});
test('RVB2S2-04 skipped epochs are never granted by a numeric range',async()=>{
 const f=windowAt(1);f.receive.regrant(3);f.receive.admit();await expect(f.receive.receive({...f.frame,epoch:2},f.store,f.emit)).rejects.toThrow('STALE_EPOCH');expect(f.counts()).toEqual({reads:0,commits:0,acks:0});
});
test('RVB2S2-04 an external grant change cannot rebind the receive window',async()=>{
 const f=windowAt(1);f.grant.regrant(2);await expect(f.receive.receive({...f.frame,epoch:2},f.store,f.emit)).rejects.toThrow('AUTH_REVOKED');expect(f.counts()).toEqual({reads:0,commits:0,acks:0});
 const moved=windowAt(1);(moved.grant as unknown as {connectionId:string}).connectionId='another-physical';await expect(moved.receive.receive(moved.frame,moved.store,moved.emit)).rejects.toThrow('AUTH_REVOKED');expect(moved.counts()).toEqual({reads:0,commits:0,acks:0});
});
test('RVB2S2-05 stable repository/path/commit/hash provenance preserves vector bytes',()=>{
 expect(JSON.stringify(source)).not.toMatch(/\.wt-/);expect(source.sources).toHaveLength(2);
 for(const s of source.sources){expect(s.repository).toBe('Android_WatchRSS_Phone');expect(s.path).toMatch(/^app\/src\/test\/resources\/b2\/[a-z0-9-]+\.json$/);expect(s.sourceCommit).toMatch(/^[0-9a-f]{40}$/);expect(s.sha256).toBe(source.sha256[s.fixture as keyof typeof source.sha256]);expect(hash(new Uint8Array(readFileSync(new URL('../fixtures/library-binary/'+s.fixture,import.meta.url))))).toBe(s.sha256);}
});
