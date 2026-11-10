import {test,expect} from 'bun:test';
import {syncV2Origin,SyncV2Http} from '../../src/sync-v2/http';
import {TrustedClock,requireTrustedNow} from '../../src/sync-v2/trusted-time';
import {SYNC_V2_PRODUCT} from '../../src/sync-v2/gate';
import {scope} from './fixture';

const base='https://api.example.com';
test('P6-2 production origin equals the v1 account backendBaseUrl host',()=>{
 expect(syncV2Origin('https://api.example.com',{accountBaseUrl:base,allowLoopback:false})).toBe('https://api.example.com');
 expect(syncV2Origin('https://api.example.com',{accountBaseUrl:base+'/',allowLoopback:false})).toBe('https://api.example.com');
 expect(syncV2Origin('https://api.example.com:8443',{accountBaseUrl:'https://api.example.com:8443',allowLoopback:false})).toBe('https://api.example.com:8443');
});
test('P6-2 origin counterexamples are all isolated_backend_required',()=>{
 const p={accountBaseUrl:base,allowLoopback:false};
 for(const origin of ['http://api.example.com','https://evil.example.com','https://api.example.com.evil.com','https://API.example.com','https://user@api.example.com','https://user:pw@api.example.com','https://api.example.com?x=1','https://api.example.com#f','https://api.example.com:443','https://api.example.com:8443','https://api.example.com/functions','https://api.example.com/','ftp://api.example.com','https://api.example.com\\@x','','http://localhost:3000','http://127.0.0.1:1','http://[::1]:2'])
  expect(()=>syncV2Origin(origin,p),origin).toThrow('isolated_backend_required');
 expect(()=>syncV2Origin(base,{accountBaseUrl:'https://api.example.com/sub',allowLoopback:false})).toThrow('isolated_backend_required');
 expect(()=>syncV2Origin(base,{accountBaseUrl:'http://api.example.com',allowLoopback:false})).toThrow('isolated_backend_required');
});
test('P6-2 loopback only in debug/test builds',()=>{
 expect(syncV2Origin('http://127.0.0.1:18990',{accountBaseUrl:base,allowLoopback:true})).toBe('http://127.0.0.1:18990');
 expect(()=>new SyncV2Http({request:async()=>{throw Error('no io');}} as any,'http://127.0.0.1:1',scope,async()=>{throw Error('no io');},false,undefined,false,false,false,false,{accountBaseUrl:base,allowLoopback:false})).toThrow('isolated_backend_required');
 const http=new SyncV2Http({request:async()=>{throw Error('no io');}} as any,base,scope,async()=>{throw Error('no io');},false,undefined,false,false,false,false,{accountBaseUrl:base,allowLoopback:false});
 expect(http.prefix).toBe(base+'/functions/v1/sync/v2');expect(http.readOnly().prefix).toBe(http.prefix);
});
test('P6-10 product switch defaults off',()=>{expect(SYNC_V2_PRODUCT.syncV2).toBe(false);expect(Object.isFrozen(SYNC_V2_PRODUCT)).toBe(true);});
test('P6-6 trusted time advances monotonically and rejects rollback beyond 5 minutes',()=>{
 let mono=1000;const clock=new TrustedClock(()=>mono);expect(clock.now()).toBeNull();expect(()=>requireTrustedNow(clock)).toThrow('trusted_time_unavailable');
 expect(clock.observe(10_000_000)).toBe(true);mono+=2000;expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(10_002_000-300_001)).toBe(false);expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(10_002_000-1000)).toBe(true);expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(20_000_000)).toBe(true);expect(clock.now()).toBe(20_000_000);
 mono+=86_400_001;expect(clock.now()).toBeNull();expect(clock.observe(1)).toBe(true);expect(clock.now()).toBe(1);
 expect(new TrustedClock(()=>mono).now()).toBeNull();
});

import {sha256Hex} from '@podjs/framework/crypto';
import {unhex} from '@podjs/framework/crypto';
import {jsonBytes} from '../../src/sync-v2/protocol';
import {vector,identityCrypto} from './fixture';
import {accountContentKey,accountScopedStorage,accountKeyPrefix,fetchRepoIdentity,receiveRepoIdentity} from '../../src/sync-v2/product';
const f=vector('identity-bootstrap'),root=unhex(f.wrapKeyHex);
const member={authorized:true,accountId:f.context.accountId,deviceId:f.request.recipientDeviceId,platform:'watch' as const};
function backend(over:{descriptor?:any;capsule?:Uint8Array;missing?:boolean}={}){
 const capsule=over.capsule??jsonBytes(f.capsule),recoveryOid='id-key-recovery:sha256:'+sha256Hex(jsonBytes(f.capsule)),descriptor=over.descriptor??f.descriptor,{descriptorOid}=require('../../src/sync-v2/identity');const seen:string[]=[];
 return {seen,transport:{request:async(r:any)=>{seen.push(r.method+' '+r.url);expect(r.headers.Authorization).toBe('Bearer t');
  if(r.url.endsWith('/repo/descriptor'))return over.missing?{status:404,headers:{},body:jsonBytes({error:{code:'object_missing',retryable:false,retryAfterMillis:null,details:{}}})}:{status:200,headers:{},body:jsonBytes({version:2,scope:f.context.scope,descriptorOid:descriptorOid(descriptor),descriptor,recoveryOid})};
  if(r.url.endsWith('/repo/id-key-recovery/'+encodeURIComponent(recoveryOid)))return {status:200,headers:{},body:capsule};throw Error('unexpected '+r.url);}} as any};
}
function memorySecure(){const map=new Map<string,string>();return {map,get:async(k:string)=>map.get(k)??null,compareAndSet:async(k:string,e:string|null,v:string)=>{if((map.get(k)??null)!==e)return false;map.set(k,v);return true;}};}
const prefix=accountKeyPrefix('https://api.example.com/','user-1');
const receive=(fetched:any,storage:any,rootFor=async()=>root)=>receiveRepoIdentity({fetched,storage,crypto:identityCrypto,random:async n=>new Uint8Array(n).fill(7),member:async()=>member,accountId:f.context.accountId,root:rootFor});

test('P6-1 contentKey is the account key; missing version is key_unavailable',async()=>{
 const keys={currentKeyVersion:async()=>2,accountKey:async(_u:string,v?:number)=>v===2?new Uint8Array(32).fill(2):undefined},ck=accountContentKey(keys,'u');
 expect((await ck.current()).version).toBe(2);await expect(ck.at(1)).rejects.toThrow('key_unavailable');
 await expect(accountContentKey({currentKeyVersion:async()=>0,accountKey:async()=>undefined},'u').current()).rejects.toThrow('key_unavailable');
});
test('P6-4 capsule receive installs K_id, pins it and reuses the pin',async()=>{
 const b=backend(),fetched=await fetchRepoIdentity(b.transport,'https://api.example.com',{accessToken:'t',legacyDeviceId:'d'});expect(fetched!.scope).toEqual(f.context.scope);
 const secure=memorySecure(),storage=accountScopedStorage(secure,prefix),installed=await receive(fetched,storage);expect(installed.idKeyHex).toBe(f.idKeyHex);
 expect([...secure.map.keys()].every(k=>k.startsWith(prefix+'syncv2.'))).toBe(true);
 expect(await receive(fetched,storage,async()=>{throw Error('root must not be needed');})).toEqual(installed);
 expect(b.seen.map(s=>s.split(' ')[0])).toEqual(['GET','GET']);
});
test('P6-4 no descriptor yet: watch waits and never creates',async()=>{expect(await fetchRepoIdentity(backend({missing:true}).transport,'https://api.example.com',{accessToken:'t',legacyDeviceId:'d'})).toBeNull();});
test('P6-4 tampered capsule, wrong root and mismatched descriptor are rejected without install',async()=>{
 const bad=jsonBytes(f.capsule);bad[bad.length-5]^=1;await expect(fetchRepoIdentity(backend({capsule:bad}).transport,'https://api.example.com',{accessToken:'t',legacyDeviceId:'d'})).rejects.toThrow('hash_mismatch');
 const fetched=(await fetchRepoIdentity(backend().transport,'https://api.example.com',{accessToken:'t',legacyDeviceId:'d'}))!,secure=memorySecure(),storage=accountScopedStorage(secure,prefix);
 await expect(receive(fetched,storage,async()=>new Uint8Array(32).fill(9))).rejects.toThrow();expect(secure.map.size).toBe(0);
 const forged={...fetched,capsule:{...f.capsule,header:{...f.capsule.header,wrappingKeyVersion:f.capsule.header.wrappingKeyVersion+1}}};await expect(receive(forged,storage)).rejects.toThrow();expect(secure.map.size).toBe(0);
 await receive(fetched,storage);const other={...fetched,descriptor:{...f.descriptor,proof:f.descriptor.proof.slice(0,-2)+'AA'}};other.descriptorOid=require('../../src/sync-v2/identity').descriptorOid(other.descriptor);await expect(receive(other,storage)).rejects.toThrow();
});
test('P6-5 K_id slot sits under the account-key prefix cleared on logout',async()=>{
 const secure=memorySecure(),storage=accountScopedStorage(secure,prefix);await receive((await fetchRepoIdentity(backend().transport,'https://api.example.com',{accessToken:'t',legacyDeviceId:'d'}))!,storage);
 for(const k of [...secure.map.keys()])if(k.startsWith(prefix))secure.map.delete(k);expect(secure.map.size).toBe(0);
 expect(()=>accountScopedStorage(secure,'watchrss.syncv2.')).toThrow('secure_store_corrupt');
});

import {watchSyncV2Product} from '../../src/sync-v2/product-start';
import {ensureR0Scan,placeholderBodyResolver} from '../../src/sync-v2/product';
function lifecycle(enabled:boolean,announce:boolean){
 const log:string[]=[];let installed:any;
 const product=watchSyncV2Product<{id:string}>({enabled,announced:async()=>{log.push('bootstrap');return announce;},open:async()=>{log.push('open');return {ui:{id:'ui'+log.length},close:async()=>{log.push('close');}};},install:port=>{installed=port;log.push(port?'install':'uninstall');}});
 return {product,log,get installed(){return installed;}};
}
test('P6-10 switch off: no bootstrap read, no runtime, no UI port',async()=>{const l=lifecycle(false,true);expect(await l.product.start('a')).toBeNull();expect(l.log).toEqual([]);expect(l.installed).toBeUndefined();});
test('P6-10 switch on without announcement: no runtime, no UI port',async()=>{const l=lifecycle(true,false);expect(await l.product.start('a')).toBeNull();expect(l.log).toEqual(['bootstrap']);expect(l.installed).toBeUndefined();});
test('P6-10 switch on with announcement opens once, installs, and unmounts on switch/logout',async()=>{
 const l=lifecycle(true,true);const [a,b]=await Promise.all([l.product.start('a'),l.product.start('a')]);expect(a).toBe(b);expect(l.log).toEqual(['bootstrap','open','install']);
 await l.product.start('b');expect(l.log).toEqual(['bootstrap','open','install','uninstall','close','bootstrap','open','install']);
 await l.product.stop();expect(l.installed).toBeUndefined();expect(l.product.active).toBe(false);expect(l.log.slice(-2)).toEqual(['uninstall','close']);
});
test('P6-10 stop during open closes the late runtime and installs nothing',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),log:string[]=[];let installed:any;
 const product=watchSyncV2Product<string>({enabled:true,announced:async()=>true,open:async()=>{await gate;return {ui:'ui',close:async()=>{log.push('close');}};},install:p=>{installed=p;}});
 const pending=product.start('a');await new Promise(r=>setTimeout(r,0));await product.stop();release();expect(await pending).toBeNull();expect(installed).toBeUndefined();expect(log).toEqual(['close']);
});
test('P6-8 R0 scan: first enable rebuilds, unfinished scan resumes, complete is a no-op',async()=>{
 const calls:string[]=[];let phase:string|null=null;const store={checkpoint:async()=>phase===null?null:{phase},scanPage:async()=>{calls.push('scan');phase='tail';},catchUpPage:async()=>{calls.push('tail');phase='complete';}};
 expect(await ensureR0Scan({store,source:{},rebuild:async()=>{calls.push('rebuild');phase='complete';}})).toBe('scanned');
 phase='scan';expect(await ensureR0Scan({store,source:{},rebuild:async()=>{throw Error('must resume');}})).toBe('resumed');expect(calls).toEqual(['rebuild','scan','tail']);
 expect(await ensureR0Scan({store,source:{},rebuild:async()=>{throw Error('no');}})).toBe('complete');
});
test('P6-9 book/asset body resolver keeps the placeholder',async()=>{expect(await placeholderBodyResolver({},null)).toBeNull();});
