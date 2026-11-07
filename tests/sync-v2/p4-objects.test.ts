import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {sealV2,objectOid} from '../../src/sync-v2/sealed';
import {LocalObjectStore} from '../../src/sync-v2/local-objects';
import {localResponse} from '../../src/sync-v2/local-read';
import {jsonBytes,parseCanonicalJson,digest} from '../../src/sync-v2/protocol';
import {signControl} from '../../src/sync-v2/signing';
import {readControlRefs} from '../../src/sync-v2/control-refs';
import {cache,openLocal,nonce,approved,phoneId,windowId,sessionId} from './p4-fixture';
import {crypt,keys} from './p3-fixture';
import {scope} from './fixture';
import {sha256Hex} from '@podjs/framework/crypto';
test('C26/C27 upload persists before ACK; Range reuses exact ciphertext',async()=>{
 const f=await cache(),source=await sealV2(crypt,keys.id,keys.content,scope,'blob',1,randomBytes(180000)),s=await openLocal(f.objects);let sourceReads=0;
 try{const result=await s.client.upload(source.oid,{size:source.bytes.length,read:async(at,n)=>{sourceReads++;return source.bytes.slice(at,at+n);}},s.windowId);expect(result.sentBytes).toBe(source.bytes.length);expect(result.receipt.kind).toBe('local');expect((await f.objects.status(source.oid)).status).toBe('present');
  expect(await s.client.object(source.oid,undefined,s.windowId)).toEqual(source.bytes);expect(await s.client.object(source.oid,{start:123,end:77777,totalBytes:source.bytes.length},s.windowId)).toEqual(source.bytes.slice(123,77778));
  const writes=f.host.writeBytes;sourceReads=0;const again=await s.client.upload(source.oid,{size:source.bytes.length,read:async(at,n)=>{sourceReads++;return source.bytes.slice(at,at+n);}},s.windowId);expect(again.sentBytes).toBe(0);expect(sourceReads).toBe(0);expect(f.host.writeBytes).toBe(writes);
 }finally{await s.close();await f.close();}
});
test('lost final part ACK is recovered as present without another source read',async()=>{
 const f=await cache(),source=await sealV2(crypt,keys.id,keys.content,scope,'blob',1,randomBytes(10000));let s=await openLocal(f.objects);
 try{f.host.afterFrame=()=>{s.serverStream.dropWriteAt=s.serverStream.writes+1;};await expect(s.client.upload(source.oid,{size:source.bytes.length,read:async(at,n)=>source.bytes.slice(at,at+n)},s.windowId)).rejects.toThrow();await s.close();
  f.host.afterFrame=undefined;const writes=f.host.writeBytes;const reopened=new LocalObjectStore(f.store,scope,async()=>{});s=await openLocal(reopened);let reads=0;const result=await s.client.upload(source.oid,{size:source.bytes.length,read:async()=>{reads++;throw Error('must_not_export');}},s.windowId);expect(result.sentBytes).toBe(0);expect(reads).toBe(0);expect(f.host.writeBytes).toBe(writes);
 }finally{await s.close();await f.close();}
});
test('partial prefix survives connection switch; only the suffix is sent',async()=>{
 const f=await cache(),source=await sealV2(crypt,keys.id,keys.content,scope,'blob',1,randomBytes(150000)),part=source.bytes.slice(0,65536),b={scope,transferId:await nonce(),oid:source.oid,totalBytes:source.bytes.length,offset:0,partBytes:part.length,partSha256:sha256Hex(part)};
 try{await f.objects.part(b,{...b,sessionId},part,sessionId);const s=await openLocal(f.objects);try{const offsets:number[]=[];const result=await s.client.upload(source.oid,{size:source.bytes.length,read:async(at,n)=>{offsets.push(at);return source.bytes.slice(at,at+n);}},s.windowId);expect(offsets[0]).toBe(65536);expect(result.sentBytes).toBe(source.bytes.length-65536);}finally{await s.close();}}
 finally{await f.close();}
});
test('C26 mismatched control/header, hash, offset and old session do zero writes',async()=>{
 const f=await cache(),data=new Uint8Array(65536).fill(3),b={scope,transferId:await nonce(),oid:objectOid('blob',data),totalBytes:data.length,offset:0,partBytes:data.length,partSha256:sha256Hex(data)},header={...b,sessionId};
 try{const before=f.host.writeBytes;for(const patch of [{transferId:'f'.repeat(32)},{offset:1},{partSha256:'0'.repeat(64)},{sessionId:'e'.repeat(32)}])await expect(f.objects.part(b,{...header,...patch},data,sessionId)).rejects.toThrow();const corrupt=data.slice();corrupt[0]^=1;await expect(f.objects.part(b,header,corrupt,sessionId)).rejects.toThrow('hash_mismatch');expect(f.host.writeBytes).toBe(before);expect((await f.objects.status(b.oid)).status).toBe('missing');}finally{await f.close();}
});
test('stateRefsGet and recipeRefsGet authenticate immutable raw J OIDs and parents',async()=>{
 const f=await cache(async()=>{});try{
  for(const type of ['state','recipe'] as const){const parentOid=type+':sha256:'+'1'.repeat(64),refs=await signControl(crypt,'fixture','wrss.sync.v2/'+type+'-refs-sign',{scope,[type+'Oid']:parentOid,[type==='state'?'segmentOids':'blobOids']:[]}),raw=jsonBytes(refs),mapping={scope,parentOid,refsOid:objectOid(type+'-refs',raw),authorDeviceId:phoneId,keyId:'e'.repeat(32),totalBytes:raw.length};
   await f.objects.registerRefs(mapping,raw,async()=>{});const s=await openLocal(f.objects);try{const result=await readControlRefs(s.client,crypt,approved,s.windowId,{type,oid:parentOid,value:type==='state'?{noteSegments:[]}:{blocks:[]}});expect(result.raw).toEqual(raw);expect(result.mapping.refsOid).toBe(mapping.refsOid);
    const second=await signControl(crypt,'fixture','wrss.sync.v2/'+type+'-refs-sign',refs.body),different=jsonBytes(second);expect(different).not.toEqual(raw);await expect(f.objects.registerRefs({...mapping,refsOid:objectOid(type+'-refs',different),totalBytes:different.length},different,async()=>{})).rejects.toThrow('idempotency_conflict');
   }finally{await s.close();}
  }
 }finally{await f.close();}
});
test('invalid/multiple Range, missing object, wrong OID and expired window are exact refusals',async()=>{
 const f=await cache(),source=await sealV2(crypt,keys.id,keys.content,scope,'blob',1,randomBytes(3));await f.objects.adopt(source.oid,source.bytes.length,async(at,n)=>source.bytes.slice(at,at+n));const s=await openLocal(f.objects);
 try{for(const range of [{start:4,end:2},{start:0,end:source.bytes.length},[{start:0,end:1}]])await expect(s.client.control('syncObjectsV2.objectGet',{scope,windowId:s.windowId,oid:source.oid,range})).rejects.toThrow('invalid_range');await expect(s.client.object('blob:sha256:'+'0'.repeat(64),undefined,s.windowId)).rejects.toThrow('object_missing');await expect(s.client.object(source.oid,undefined,'f'.repeat(32))).rejects.toThrow('window_expired');await expect(s.client.control('syncObjectsV2.objectGet',{scope,windowId:s.windowId,oid:'bad',range:null})).rejects.toThrow('invalid_oid');}
 finally{await s.close();await f.close();}
});
