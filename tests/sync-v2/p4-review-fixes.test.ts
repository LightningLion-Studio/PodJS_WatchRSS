import {test,expect} from 'bun:test';
import {sha256Hex} from '@podjs/framework/crypto';
import {LocalObjectStore,partHeader,partFrameHeader} from '../../src/sync-v2/local-objects';
import {LocalProofSession,type MemberStatus} from '../../src/sync-v2/local-proof';
import {WatchLocalObjectSession} from '../../src/sync-v2/local-session';
import {LocalReadService} from '../../src/sync-v2/local-read';
import {objectCapability} from '../../src/sync-v2/local-capability';
import {PeerCustodyStore} from '../../src/sync-v2/peer-custody';
import {signCommit,signControl,verifyCommit} from '../../src/sync-v2/signing';
import {canonical,digest,jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {cache,openLocal,nonce,proofs,approved,watchId,phoneId,sessionId} from './p4-fixture';
import {crypt} from './p3-fixture';
import {scope} from './fixture';
const good=new Uint8Array([4,5,6]),bad=new Uint8Array([9,8,7]),blob='blob:sha256:'+sha256Hex(good);
const body=(oid:string,data:Uint8Array)=>({scope,transferId:'a'.repeat(32),oid,totalBytes:data.length,offset:0,partBytes:data.length,partSha256:sha256Hex(data)});
for(const entry of ['complete','status','part'] as const)test('P4R-01 '+entry+' discards a failed full prefix and allows a correct same-OID retry after reopen',async()=>{
 const f=await cache(async()=>{});try{const b=body(blob,bad);await f.objects.part(b,partFrameHeader(b,sessionId),bad,sessionId);
  await expect(entry==='complete'?f.objects.complete(blob,3):entry==='status'?f.objects.status(blob):f.objects.part(body(blob,good),partFrameHeader(body(blob,good),sessionId),good,sessionId)).rejects.toThrow('hash_mismatch');
  const reopened=new LocalObjectStore(f.store,scope,async()=>{});expect(await reopened.status(blob)).toEqual({oid:blob,status:'missing',totalBytes:null,durableOffset:0,receipt:null});expect(await f.store.get('local-present:'+blob)).toBeNull();
  await reopened.adopt(blob,good.length,async(at,n)=>good.slice(at,at+n));expect(await(await reopened.object(blob)).read(0,3)).toEqual(good);
 }finally{await f.close();}
});
test('P4R-01 a bad commit signature cannot occupy its body OID after full authentication fails',async()=>{
 const c=await signCommit(crypt,'fixture',{version:2,scope,authorDeviceId:watchId,deviceSequence:'1',previousOwnCommit:null,mergedParents:[],treeRoot:'tree:sha256:'+'1'.repeat(64),requiredFeatures:[],createdAtMillis:1,observedRefs:[],indexComplete:true,accountParent:null,rollbackGeneration:'0',operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null}}),key=await approved(watchId),auth=async(id:string,raw:Uint8Array)=>{await verifyCommit(crypt,key.publicKey,parseCanonicalJson(raw),id,scope);},f=await cache(auth),valid=jsonBytes({body:c.body,signature:c.signature}),invalid=jsonBytes({body:c.body,signature:b64(new Uint8Array(64))});
 try{expect(invalid.length).toBe(valid.length);const b=body(c.oid,invalid);await f.objects.part(b,partFrameHeader(b,sessionId),invalid,sessionId);await expect(f.objects.complete(c.oid,invalid.length)).rejects.toThrow('signature_invalid');
  const reopened=new LocalObjectStore(f.store,scope,auth);expect((await reopened.status(c.oid)).status).toBe('missing');await reopened.adopt(c.oid,valid.length,async(at,n)=>valid.slice(at,at+n));expect(await(await reopened.object(c.oid)).read(0,valid.length)).toEqual(new Uint8Array(valid));
 }finally{await f.close();}
});
test('P4R-01 cleanup never discards an authenticated copy, another object or a durable custody obligation',async()=>{
 let reject=false;const f=await cache(async()=>{if(reject)throw Error('signature_invalid');});try{
  await f.objects.adopt(blob,3,async(at,n)=>good.slice(at,at+n));const prior=await f.store.get('local-present:'+blob),[session]=await proofs(),custody=new PeerCustodyStore(f.store,scope,watchId,crypt,approved),pin=await signControl(crypt,'fixture','wrss.sync.v2/custody-pin-sign',{version:2,scope,pinId:await nonce(),holderDeviceId:phoneId,claimantDeviceId:watchId,entityKey:'1'.repeat(64),bodyRevision:'2'.repeat(32),recipeOid:'recipe:sha256:'+'3'.repeat(64),blobOidsHash:digest([]),createdAtMillis:1});await custody.accept(pin,session);const retained=await f.store.get('custody-id:'+pin.body.pinId);
  let discards=0;f.host.discardHook=()=>{discards++;};reject=true;await expect(f.objects.complete(blob,3)).rejects.toThrow('signature_invalid');expect(discards).toBe(0);expect(await f.store.get('local-present:'+blob)).toEqual(prior);reject=false;
  const other='blob:sha256:'+sha256Hex(new Uint8Array([1,2,3])),b=body(other,bad);await f.objects.part(b,partFrameHeader(b,sessionId),bad,sessionId);await expect(f.objects.complete(other,3)).rejects.toThrow('hash_mismatch');expect(discards).toBe(1);
  expect(await(await f.objects.object(blob)).read(0,3)).toEqual(good);expect(await f.store.get('custody-id:'+pin.body.pinId)).toEqual(retained);expect((await custody.authorize({scope,entityKey:pin.body.entityKey,bodyRevision:pin.body.bodyRevision,recipeOid:pin.body.recipeOid,blobOids:[]})).kind).toBe('peer-custody');
 }finally{await f.close();}
});
test('P4R-01 a lost discard reply still leaves a durable zero prefix for correct retry',async()=>{
 const f=await cache(async()=>{});try{const b=body(blob,bad);await f.objects.part(b,partFrameHeader(b,sessionId),bad,sessionId);f.host.discardHook=()=>{throw Error('lost_discard_reply');};await expect(f.objects.complete(blob,3)).rejects.toThrow('lost_discard_reply');f.host.discardHook=undefined;const reopened=new LocalObjectStore(f.store,scope,async()=>{});expect((await reopened.status(blob)).status).toBe('missing');await reopened.adopt(blob,3,async(at,n)=>good.slice(at,at+n));expect((await reopened.status(blob)).status).toBe('present');}finally{await f.close();}
});
test('P4R-01 another write cannot race whole-object authentication or prefix cleanup',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),f=await cache(async()=>{entered();await gate;});try{const b=body(blob,good);await f.objects.part(b,partFrameHeader(b,sessionId),good,sessionId);const completing=f.objects.complete(blob,3);await started;await expect(f.objects.part(body(blob,bad),partFrameHeader(body(blob,bad),sessionId),bad,sessionId)).rejects.toThrow('object_busy');release();await completing;expect(await(await f.objects.object(blob)).read(0,3)).toEqual(good);}finally{release();await f.close();}
});
for(const action of ['negotiate','haveWant','objectGet','recipeRefsGet','stateRefsGet','treeDiff'])test('P4R-03 revoked-after-proof '+action+' refuses the request and invalidates the session',async()=>{
 let member:MemberStatus='active',captures=0;const f=await cache(async()=>{});const projection=f.db.store();await projection.initialize();const unchanged=await projection.readState();const s=await openLocal(f.objects,{snapshot:async()=>{captures++;return {serverRevision:'0',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null};}},undefined,async()=>member);
 try{member='revoked';const b=action==='negotiate'?{scope,knownRefs:[],features:[]}:action==='haveWant'?{scope,windowId:s.windowId,oids:[blob]}:action==='objectGet'?{scope,windowId:s.windowId,oid:blob,range:null}:action==='treeDiff'?{scope,windowId:s.windowId,treeRoot:'tree:sha256:'+'1'.repeat(64),knownNodes:[],pageToken:null}:{scope,windowId:s.windowId,parentOid:(action==='stateRefsGet'?'state':'recipe')+':sha256:'+'1'.repeat(64)};
  const reads=f.host.readBytes;await expect(s.client.control('syncObjectsV2.'+action,b)).rejects.toThrow('member_revoked');await s.running;expect(s.serverProof.verified).toBe(false);expect(s.serverStream.closed).toBe(true);expect(captures).toBe(1);expect(f.host.readBytes).toBe(reads);expect(await projection.readState()).toEqual(unchanged);
 }finally{await s.close();await f.close();}
});
test('P4R-03 revocation during a new snapshot is rechecked before its window is published',async()=>{
 let member:MemberStatus='active',revoke=false;const f=await cache(async()=>{}),s=await openLocal(f.objects,{snapshot:async()=>{if(revoke)member='revoked';return {serverRevision:'0',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null};}},undefined,async()=>member);
 try{revoke=true;await expect(s.client.control('syncObjectsV2.negotiate',{scope,knownRefs:[],features:[]})).rejects.toThrow('member_revoked');expect(s.serverProof.verified).toBe(false);}finally{await s.close();await f.close();}
});
test('P4R-03 revocation during object authentication returns no metadata or object bytes',async()=>{
 let member:MemberStatus='active',revoke=false;const f=await cache(async()=>{if(revoke)member='revoked';});await f.objects.adopt(blob,3,async(at,n)=>good.slice(at,at+n));const s=await openLocal(f.objects,{},undefined,async()=>member);
 try{revoke=true;await expect(s.client.object(blob,undefined,s.windowId)).rejects.toThrow('member_revoked');expect(s.serverProof.verified).toBe(false);}finally{await s.close();await f.close();}
});
test('P4R-03 a streamed part is not emitted if membership changes while its source read awaits',async()=>{
 let active=true,parts=0,metadata=0;const check=async()=>{if(!active)throw Error('member_revoked');},source={size:3,read:async()=>{active=false;return good;}},reader=new LocalReadService({object:async()=>source} as any,scope,sessionId,async()=>{},nonce,check),frames={writeControl:async()=>{metadata++;},writePart:async()=>{parts++;}};
 await expect(reader.read({requestId:await nonce(),action:'syncObjectsV2.objectGet',body:{scope,windowId:'1'.repeat(32),oid:blob,range:null}},frames as any)).rejects.toThrow('member_revoked');expect(metadata).toBe(1);expect(parts).toBe(0);
});
test('P4R-04 every data header has exactly seven C33 fields and rejects transferId',async()=>{
 const h=partFrameHeader(body(blob,good),sessionId);expect(Object.keys(h).sort()).toEqual(['scope','sessionId','oid','totalBytes','offset','partBytes','partSha256'].sort());expect(partHeader(h,scope,sessionId)).toEqual(h);expect(()=>partHeader({...h,transferId:'1'.repeat(32)},scope,sessionId)).toThrow('invalid_schema');for(const key of Object.keys(h)){const missing:any={...h};delete missing[key];expect(()=>partHeader(missing,scope,sessionId)).toThrow('invalid_schema');}
});
test('P4R-04 objectGet keeps its control transferId but emits only seven-field download headers',async()=>{
 const f=await cache(async()=>{});await f.objects.adopt(blob,3,async(at,n)=>good.slice(at,at+n));const s=await openLocal(f.objects);try{const rid=await nonce();await s.frames.writeControl({requestId:rid,action:'syncObjectsV2.objectGet',body:{scope,windowId:s.windowId,oid:blob,range:null}});const control=await s.frames.read(10000);expect(control.kind).toBe('control');if(control.kind!=='control')throw Error();expect(control.value.body.transferId).toMatch(/^[a-f0-9]{32}$/);const data=await s.frames.read(10000);expect(data.kind).toBe('part');if(data.kind!=='part')throw Error();expect(Object.keys(data.header).length).toBe(7);expect(data.header).not.toHaveProperty('transferId');expect(data.payload).toEqual(good);}finally{await s.close();await f.close();}
});
const snapshot=async()=>({refs:[],serverRevision:'0',historyFloorRevision:'0',checkpointOid:null,account:{commitOid:null,revision:'0',rollbackGeneration:'0'}});
async function windowControl(local:string[],peer:string[]){const f=await cache(async()=>{}),proof=new LocalProofSession(sessionId,new Uint8Array(32),{scope,deviceId:phoneId,nonce:'1'.repeat(32),features:local},async()=> 'active',()=>true),other=new LocalProofSession(sessionId,new Uint8Array(32),{scope,deviceId:watchId,nonce:'2'.repeat(32),features:peer},async()=> 'active',()=>true);await proof.negotiate(other.hello);await other.negotiate(proof.hello);await proof.verify(other.proof(),[]);await other.verify(proof.proof(),[]);let captures=0;const session=new WatchLocalObjectSession({enabled:true,proof,objects:f.objects,nonce,requiredFeatures:[],supportedFeatures:local,snapshot:async()=>{captures++;return snapshot();},closeSocket:async()=>{}});await session.probe(objectCapability(scope,true,[],peer));return {f,session,captures:()=>captures,send:async(body:any)=>{let answer:any;await session.handle({requestId:await nonce(),action:'syncObjectsV2.negotiate',body},{readFrame:async()=>({}),writeFrame:async v=>{answer=v;},close:async()=>{}});return answer;},async close(){await session.close();await f.close();}};}
test('P4R-05 a requested feature must belong to both immutable C25 hellos',async()=>{
 const one=await windowControl(['witness'],[]);try{expect((await one.send({scope,knownRefs:[],features:['witness']})).error.code).toBe('feature_missing');expect(one.captures()).toBe(0);expect((await one.send({scope,knownRefs:[],features:[]})).ok).toBe(true);}finally{await one.close();}
 const both=await windowControl(['future','witness'],['witness']);try{expect((await both.send({scope,knownRefs:[],features:['future']})).error.code).toBe('feature_missing');expect((await both.send({scope,knownRefs:[],features:['witness']})).ok).toBe(true);}finally{await both.close();}
});
for(const knownRefs of [[{}],[{ref:'refs/account/current',oid:null}],[{ref:4,oid:null,revision:'0'}],[{ref:'x',oid:blob,revision:'1'}],[{ref:'x',oid:null,revision:0}],[{ref:'x',oid:null,revision:'01'}],[{ref:'x',oid:null,revision:'18446744073709551616'}],[{ref:'x',oid:null,revision:'0',extra:true}],Array(66).fill({ref:'x',oid:null,revision:'0'})])test('P4R-05 cloud knownRefs schema rejects '+canonical(knownRefs).slice(0,95),async()=>{
 const s=await windowControl([],[]);try{expect((await s.send({scope,knownRefs,features:[]})).error.code).toBe('invalid_schema');expect(s.captures()).toBe(0);}finally{await s.close();}
});
test('P4R-05 valid cloud hint schema permits nullable OIDs and up to 65 rows without imposing a different ref grammar',async()=>{
 const s=await windowControl([],[]);try{const knownRefs=Array.from({length:65},(_,i)=>({ref:i%2?'refs/devices/synthetic/index':'',oid:i%2?'commit:sha256:'+'1'.repeat(64):null,revision:String(i)}));expect((await s.send({scope,knownRefs,features:[]})).ok).toBe(true);expect(s.captures()).toBe(1);}finally{await s.close();}
});
test('P4R-05 later option changes cannot add a feature absent from the first local hello',async()=>{
 const local:string[]=[],peer=['witness'],s=await windowControl(local,peer);try{local.push('witness');expect((await s.send({scope,knownRefs:[],features:['witness']})).error.code).toBe('feature_missing');expect(s.captures()).toBe(0);}finally{await s.close();}
});
