import {test,expect} from 'bun:test';
import {createHash,createHmac,verify,createPublicKey,randomBytes} from 'node:crypto';
import vectors from './fixtures/v2-vectors.json';
import {lengthPrefix,hex,unhex} from '@podjs/framework/crypto';
import {commit,rotation,attest,approvalCommitment,approvalCode,transcript,verifyDelivery,type V2Crypto} from '../../src/cloud/v2';
import {WatchCloudKeyManager,type CloudStringStore} from '../../src/cloud/keys';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {WatchCloudClient} from '../../src/cloud/client';
import {WatchCloudApproval} from '../../src/cloud/approval';
import {WatchAccountStore} from '../../src/account/store';
import {clearAccountCloud} from '../../src/account/cloud-cleanup';
import {WatchTokenManager} from '../../src/account/token';
import {syncAccount} from '../../src/sync/account-actions';
import type {CloudTrust,CloudKeyEnvelope} from '../../src/cloud/types';
const guard={require(){}};
const crypto:V2Crypto={sha256:async b=>createHash('sha256').update(b).digest('hex'),hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex'),random:async n=>new Uint8Array(randomBytes(n)),verify:async(spki,b,sig)=>verify('sha256',b,{key:createPublicKey({key:Buffer.from(spki),type:'spki',format:'der'}),dsaEncoding:'ieee-p1363'},sig)};
const {userId:u,libraryEpoch:e}=vectors.inputs,a=vectors.approval;
const keys=[vectors.inputs.K1_hex,vectors.inputs.K2_hex,vectors.inputs.K3_hex].map(unhex);
const trust:CloudTrust={libraryEpoch:e,keyVersionFloor:0,keyCommitments:keys.map((_,i)=>({keyVersion:i+1,commitment:(vectors.commit as any)[i+1],rotationProof:i?(vectors.rotationProof as any)[i+1]:null}))};
const t={userId:u,libraryEpoch:e,requestId:a.requestId,deviceId:a.requesterDeviceId,publicKeySpki:a.requesterSpki_b64,approverDeviceId:a.approverDeviceId,approverSpki:a.approverSpki_b64,requesterNonce:a.requesterNonce_b64,approverNonce:a.approverNonce_b64};
class Store implements CloudStringStore {values=new Map<string,string>();async get(k:string){return this.values.get(k);}async set(k:string,v:string){this.values.set(k,v);}async update(values:Record<string,string|null>,prefixes:string[]=[]){for(const k of this.values.keys())if(prefixes.some(p=>k.startsWith(p)))this.values.delete(k);for(const [k,v]of Object.entries(values))if(v===null)this.values.delete(k);else this.values.set(k,v);}}
const envelope=(v:number):CloudKeyEnvelope=>({algorithm:'P-256+HKDF-SHA256+A256GCM',keyVersion:v,ephemeralPublicKeySpki:'fixture',nonceBase64:Buffer.alloc(12).toString('base64'),wrappedKeyBase64:Buffer.alloc(48).toString('base64')});
const envelopes=keys.map((_,i)=>envelope(i+1));
const attestation={keyVersion:3,mac:vectors.attest.mac};
function manager(store=new Store(),base='https://backend.test',wrong=false){return {store,manager:new WatchCloudKeyManager({sha256:crypto.sha256,hmac:crypto.hmac,publicKey:async()=>a.requesterSpki_b64,unwrap:async args=>{const v=Number(Buffer.from(args.infoBase64,'base64').toString().match(/v(\d+)\//)![1]);return wrong?new Uint8Array(32):keys[v-1].slice();}},store,guard,base)};}
test('SPEC vectors: LP, all commitments/proofs, attestation, transcript, code and exact payload signature',async()=>{
 expect(hex(lengthPrefix(...vectors.lp.fields))).toBe(vectors.lp.hex);
 for(let i=0;i<3;i++){expect(await commit(crypto,keys[i],u,e,i+1)).toBe((vectors.commit as any)[i+1]);if(i)expect(await rotation(crypto,keys[i-1],u,e,i+1,(vectors.commit as any)[i+1])).toBe((vectors.rotationProof as any)[i+1]);}
 expect(await attest(crypto,keys[2],u,e,vectors.attest.deviceId,vectors.attest.spki_b64)).toBe(vectors.attest.mac);
 expect(await approvalCommitment(crypto,t.publicKeySpki,t.requesterNonce)).toBe(a.commitment);expect(hex(transcript(t))).toBe(a.transcript_hex);expect(await crypto.sha256(transcript(t))).toBe(a.transcriptSha256_hex);expect(await approvalCode(crypto,t)).toBe(a.code);
 expect(await verifyDelivery(crypto,t,a.payload,a.signature_b64)).toBe(true);expect(await verifyDelivery(crypto,t,a.payload+' ',a.signature_b64)).toBe(false);expect(await verifyDelivery(crypto,{...t,libraryEpoch:'different'},a.payload,a.signature_b64)).toBe(false);
 expect(await rotation(crypto,keys[0],u,e,3,vectors.commit['3'])).toBe(vectors.negative.rotationProof3_with_wrong_prev);
});
test('H1/H2: all-or-nothing chain and attestation validation, cached versions rechecked, highest verified write version',async()=>{
 const f=manager();expect(await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation)).toBe('ready');expect(await f.manager.currentKeyVersion(u)).toBe(3);expect(await f.manager.accountKey(u,2)).toEqual(keys[1]);
 const reopened=manager(f.store).manager;expect(await reopened.accountKey(u)).toBeUndefined();expect(await reopened.acceptBootstrap(u,t.deviceId,[],trust,attestation)).toBe('ready');expect(await reopened.keyVersions(u)).toEqual([1,2,3]);
 const changed=structuredClone(trust);changed.keyCommitments[0].commitment='0'.repeat(64);await expect(reopened.acceptBootstrap(u,t.deviceId,[],changed,attestation)).rejects.toThrow('library_epoch_mismatch');expect([...f.store.values.keys()]).toHaveLength(0);
 for(const mode of ['proof','attest','missing','uncommitted','wrong']){const g=manager(new Store(),'https://backend.test',mode==='wrong'),tr=structuredClone(trust);if(mode==='proof')tr.keyCommitments[2].rotationProof=vectors.negative.rotationProof3_with_wrong_prev;
 await expect(g.manager.acceptDelivery(u,t.deviceId,mode==='missing'?envelopes.slice(1):mode==='uncommitted'?[...envelopes,envelope(4)]:envelopes,tr,mode==='attest'?{...attestation,mac:'0'.repeat(64)}:attestation)).rejects.toThrow();expect(await g.manager.currentKeyVersion(u)).toBe(0);expect([...g.store.values.keys()].filter(k=>k.endsWith('.1')||k.endsWith('.2')||k.endsWith('.3'))).toHaveLength(0);}
});
test('epoch, backend and user scopes fence keys, applied heads, sequence and hashes',async()=>{
 const f=manager();await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation);
 expect(await manager(f.store,'https://other.test').manager.acceptBootstrap(u,t.deviceId,[],trust)).toBe('waiting-approval');
 const newTrust={...trust,libraryEpoch:'00000000-0000-4000-8000-000000000000',keyCommitments:[]};expect(await f.manager.acceptBootstrap(u,t.deviceId,[],newTrust)).toBe('waiting-approval');expect(await f.manager.accountKey(u)).toBeUndefined();
 const state=new WatchCloudStateStore(f.store,u,'watch',guard,'https://backend.test');await state.acceptEpoch(e);await state.markApplied('phone',55,true);await state.markUploaded('a'.repeat(64),true);expect(await state.nextSequence(4)).toBe(5);
 const other=new WatchCloudStateStore(f.store,u,'watch',guard,'https://other.test');expect(await other.applied('phone',true)).toBe(0);
 expect(await state.acceptEpoch(newTrust.libraryEpoch)).toBe(true);expect(await state.applied('phone',true)).toBe(0);expect(await state.lastContentHash(true)).toBeUndefined();expect(await state.nextSequence(0)).toBe(1);
});
test('secure.update keeps independent manager/version writes and never persists raw failed delivery',async()=>{
 const store=new Store(),f=manager(store).manager,g=manager(store).manager;await Promise.all([f.acceptDelivery(u,t.deviceId,envelopes.slice(0,1),{...trust,keyCommitments:trust.keyCommitments.slice(0,1)},{keyVersion:1,mac:await attest(crypto,keys[0],u,e,t.deviceId,t.publicKeySpki)}),g.acceptDelivery(u,t.deviceId,envelopes,trust,attestation)]);expect(await g.keyVersions(u)).toEqual([1,2,3]);expect([...store.values.keys()].filter(k=>k.includes(e))).toHaveLength(3);
});
test('cloud metadata writes carry epoch; bootstrap is read; 409 invalidates before returning and 426 maps to upgrade',async()=>{
 let status=200,invalidated=0;const calls:any[]=[];const client=new WatchCloudClient({request:async r=>{calls.push(r);return{status,headers:{},body:new TextEncoder().encode(JSON.stringify({member:{},error:status===409?'library_epoch_mismatch':undefined}))};}},{baseUrl:'https://backend.test',accessToken:'token',onEpochMismatch:async()=>{invalidated++;}},crypto,guard);
 await client.bootstrap();expect(calls[0].headers['x-watchrss-library-epoch']).toBeUndefined();await expect(client.registerDevice('w','w','spki',1)).rejects.toThrow('client_upgrade_required');client.setEpoch(e);await client.approvalCreate('w','a'.repeat(64));expect(calls.at(-1).headers['x-watchrss-library-epoch']).toBe(e);status=409;await expect(client.completeSnapshot('s',[])).rejects.toThrow('library_epoch_mismatch');expect(invalidated).toBe(1);client.setEpoch(e);status=426;await expect(client.approvalReveal('id','nonce')).rejects.toThrow('client_upgrade_required');
});
function approvalFixture(){let time=1,current=true,signature=a.signature_b64,payload=a.payload,status='accepted',accepts=0,reveals=0,gets=0,error='',deliveryResult:'ready'|'waiting-approval'='ready',getWait:Promise<void>|undefined;const responses:any={requestId:a.requestId,deviceId:t.deviceId,publicKeySpki:t.publicKeySpki,commitment:a.commitment,expiresAt:300001,approverDeviceId:t.approverDeviceId,approverSpki:t.approverSpki,approverNonce:t.approverNonce,requesterNonce:t.requesterNonce};
 const machine=new WatchCloudApproval({userId:u,deviceId:t.deviceId,trust,crypto:{...crypto,random:async()=>new Uint8Array(Buffer.from(t.requesterNonce,'base64'))},keys:{publicKeySpki:async()=>t.publicKeySpki,acceptDelivery:async()=>{accepts++;return deliveryResult;}},client:{approvalCreate:async()=>({requestId:a.requestId,expiresAt:300001}),approvalGet:async()=>{gets++;if(getWait)await getWait;if(error)throw Error(error);return{...responses,status,payload,signature};},approvalReveal:async()=>{reveals++;},approvalCancel:async()=>{},bootstrap:async()=>({...trust,member:{} as any,devices:[],keyEnvelopes:[]})},assertCurrent:async()=>{if(!current)throw Error('account changed');},now:()=>time});return {machine,responses,get accepts(){return accepts;},get reveals(){return reveals;},get gets(){return gets;},set:(x:any)=>{status=x.status??status;time=x.time??time;signature=x.signature??signature;payload=x.payload??payload;current=x.current??current;error=x.error??error;deliveryResult=x.deliveryResult??deliveryResult;getWait=x.getWait??getWait;}};}
test('approval N reveals only its nonce, displays SAS, expires/cancels and rejects changed approver or signature before saving',async()=>{
 const f=approvalFixture();await f.machine.start();await f.machine.poll();expect(f.reveals).toBe(1);expect(f.machine.status).toEqual({phase:'code',code:a.code,confirmed:false});expect(f.accepts).toBe(0);
 f.responses.approverDeviceId='changed';await expect(f.machine.poll()).rejects.toThrow('approver_changed');expect(f.accepts).toBe(0);
 for(const change of [{status:'delivered',payload:a.payload+' '},{status:'delivered',signature:Buffer.alloc(64).toString('base64')},{current:false}]){const g=approvalFixture();await g.machine.start();g.set(change);await expect(g.machine.poll()).rejects.toThrow();expect(g.accepts).toBe(0);}
 const g=approvalFixture();await g.machine.start();await g.machine.cancel();await g.machine.poll();expect(g.machine.status.phase).toBe('cancelled');expect(g.accepts).toBe(0);
});
test('approval signed fixture is verified before schema checks, so placeholder envelope is never stored',async()=>{
 const f=approvalFixture();await f.machine.start();await f.machine.poll();await f.machine.confirmCode(true);f.set({status:'delivered'});await expect(f.machine.poll()).rejects.toThrow('invalid_approval_payload');expect(f.accepts).toBe(0);
});
const account=(userId:string)=>({userId,backendBaseUrl:'https://backend.test',watchDeviceToken:'token',watchRefreshToken:'refresh',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:9e15,phoneMasked:'',installId:'i',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1});
test('H6: 401 cleanup retains library owner, blocks silent re-pair and explicit clear/merge resolves it',async()=>{
 const values=new Map<string,string>();let cleared=0;const store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);},clearCloudScope:async()=>{cleared++;}});await store.save(account('A'));
 await expect(store.save(account('B'))).rejects.toThrow('account_switch_rejected');const token=new WatchTokenManager(store,{backendBaseUrl:'https://backend.test',transport:{request:async()=>({status:401,headers:{},body:new Uint8Array()})}});await expect(token.freshAccount(true)).rejects.toThrow();expect(await store.read()).toBeNull();expect(cleared).toBe(1);await expect(store.save(account('B'))).rejects.toThrow('library_owner_mismatch');let localClear=0;await store.resolveLibraryOwner(account('B'),'clear',async()=>{localClear++;});await store.save(account('B'));expect(localClear).toBe(1);await store.clear();await store.resolveLibraryOwner(account('C'),'merge');await store.save(account('C'));expect((await store.read())?.userId).toBe('C');
});
test('logout removes scoped and legacy keys/state/cache via host atomic prefix cleanup',async()=>{
 const calls:any[]=[];await clearAccountCloud(async<T>(m:string,args:any)=>{calls.push({m,args});if(m==='crypto.hash')return{digestBase64:Buffer.from(await crypto.sha256(Buffer.from(args.dataBase64,'base64')),'hex').toString('base64')} as T;if(m==='file.list')return{entries:[{path:args.path+'/cipher.bin',directory:false}]} as T;return{} as T;},account('A'));
 expect(calls.find(c=>c.m==='secure.update').args.removePrefixes).toHaveLength(5);expect(calls.filter(c=>c.m==='file.delete')).toHaveLength(2);
});

test('approval N accepts a valid signed full delivery once and rejects replay after terminal state',async()=>{
 const {createPrivateKey,sign}=await import('node:crypto');const der=Buffer.from(t.approverSpki,'base64'),point=der.subarray(-64);
 const privateKey=createPrivateKey({key:{kty:'EC',crv:'P-256',d:Buffer.from(a.approverPrivateScalar_hex,'hex').toString('base64url'),x:point.subarray(0,32).toString('base64url'),y:point.subarray(32).toString('base64url')},format:'jwk'});
 const payload=JSON.stringify({envelopes:envelopes.map(envelope=>({keyVersion:envelope.keyVersion,envelope})),attestation});
 const signature=sign('sha256',lengthPrefix('watchrss/approval-deliver/v2',unhex(await crypto.sha256(transcript(t))),payload),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 const f=approvalFixture();await f.machine.start();await f.machine.poll();await f.machine.confirmCode(true);f.set({status:'delivered',payload,signature,time:999999999});await f.machine.poll();expect(f.machine.status.phase).toBe('complete');expect(f.accepts).toBe(1);await f.machine.poll();expect(f.accepts).toBe(1);
 const g=approvalFixture();await g.machine.start();await g.machine.poll();await g.machine.confirmCode(true);g.set({status:'delivered',payload,signature,deliveryResult:'waiting-approval'});await expect(g.machine.poll()).rejects.toThrow('waiting_approval');expect(g.machine.status.phase).toBe('error');
});
test('QR configure/key/finish readiness requires verified bootstrap and batch attestation',async()=>{
 const {WatchSetupHandler}=await import('../../src/onboarding/watch-setup');let ready=false,saved=false,deliveries=0;
 const handler=new WatchSetupHandler({deviceId:'watch',installId:'install',now:()=>1,active:()=>true,pairing:{sessionId:'pair',secret:keys[0]},crypto,confirm:async()=>true,readAccount:async()=>null,saveAccount:async()=>{saved=true;},publicKey:async()=>t.publicKeySpki,verifiedReady:async()=>ready,currentKeyVersion:async()=>ready?3:0,trust:async()=>trust,acceptDelivery:async()=>{deliveries++;ready=true;},parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});
 await handler.handle({action:'prepare',userId:u});const r=await handler.handle({action:'configure',account:{userId:u,installId:'install',backendBaseUrl:'https://sly-data-plane.watchrss.cn',watchAccessToken:'token',accessTokenExpiresAt:9999,watchRefreshToken:'refresh'}});expect(saved).toBe(true);expect(r.cloudReady).toBe(false);await expect(handler.handle({action:'key',userId:u,envelope:envelope(1)})).rejects.toThrow('client_upgrade_required');expect(deliveries).toBe(0);await handler.handle({action:'key',userId:u,payload:JSON.stringify({envelopes:envelopes.map(envelope=>({keyVersion:envelope.keyVersion,envelope})),attestation})});expect(deliveries).toBe(1);ready=false;await expect(handler.handle({action:'finish',cloudReady:true})).rejects.toThrow('waiting_approval');
});
test('host crypto orphan cleanup touches only staging files; secret service arguments are absent from PERF_TRACE',async()=>{
 const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const deleted:string[]=[];const ports=createCloudHostPorts(async<T>(m:string,args:any)=>{if(m==='file.list')return{entries:[{path:'cloud-crypto/.pod-write-orphan.part'},{path:'cloud-crypto/keep.bin'}]} as T;if(m==='file.delete')deleted.push(args.path);return{} as T;},guard);await ports.cleanupCrypto();expect(deleted).toEqual(['cloud-crypto/.pod-write-orphan.part']);
 const java=await Bun.file('/home/wilf/data/PodJS/podjs-watch.wt-cloud-v2/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodServices.java').text();expect(java).not.toContain('args.toString().substring');expect(java).toContain('private static final boolean PERF_TRACE = false;');
 const gradle=await Bun.file('/home/wilf/data/PodJS/podjs-watch.wt-cloud-v2/platforms/android/runtime/build.gradle.kts').text();expect(gradle).toContain('dependsOn(verifyReleaseServiceTracing)');
});

test('concurrent account saves reject the second owner, and an old refresh cannot resurrect logout',async()=>{
 const values=new Map<string,string>();const store=new WatchAccountStore({get:k=>values.get(k)??null,set:async(k,v)=>{await Promise.resolve();values.set(k,v);},remove:k=>{values.delete(k);}});
 const result=await Promise.allSettled([store.save(account('A')),store.save(account('B'))]);expect(result.map(x=>x.status)).toEqual(['fulfilled','rejected']);const old=(await store.read())!;await store.clear();await expect(store.save({...old,watchDeviceToken:'new'},old)).rejects.toThrow('账号已变更');expect(await store.read()).toBeNull();
});
test('approval rejects delivery that skipped the pinned accepted/reveal/code phase',async()=>{
 const f=approvalFixture();await f.machine.start();f.set({status:'delivered'});await expect(f.machine.poll()).rejects.toThrow('approval_reveal_required');expect(f.accepts).toBe(0);
});

test('R8 legacy watches wait without commitments and upgrade only against matching server commitments',async()=>{
 const f=manager(),legacyName='watchrss.cloud.keys.'+await crypto.sha256(new TextEncoder().encode(u));await f.store.set(legacyName,JSON.stringify(Object.fromEntries(keys.map((k,i)=>[i+1,Buffer.from(k).toString('base64')]))));
 expect(await f.manager.prepareLegacyUpgrade(u,t.deviceId,{...trust,keyCommitments:[]})).toBeUndefined();expect(await f.manager.accountKey(u)).toBeUndefined();
 const prepared=await f.manager.prepareLegacyUpgrade(u,t.deviceId,trust);expect(prepared?.attestation).toEqual(attestation);
 expect(await f.manager.acceptBootstrap(u,t.deviceId,[],trust,attestation)).toBe('ready');expect(await f.manager.currentKeyVersion(u)).toBe(3);expect(f.store.values.has(legacyName)).toBe(false);expect(await f.manager.accountKey(u,1)).toEqual(keys[0]);
});
test('bootstrap rotation accepts an older valid device attestation while authenticating every new key with the previous key',async()=>{
 const f=manager(),first={...trust,keyCommitments:trust.keyCommitments.slice(0,1)},oldAttest={keyVersion:1,mac:await attest(crypto,keys[0],u,e,t.deviceId,t.publicKeySpki)};await f.manager.acceptDelivery(u,t.deviceId,envelopes.slice(0,1),first,oldAttest);
 const remote=envelopes.slice(1).map((envelope,i)=>({id:String(i),recipientType:'device',recipientDeviceId:t.deviceId,envelope}));expect(await f.manager.acceptBootstrap(u,t.deviceId,remote,trust,oldAttest)).toBe('ready');expect(await f.manager.currentKeyVersion(u)).toBe(3);
});

test('R1 delivered payload is not processed before local agreement; disagreement cancels',async()=>{
 const f=approvalFixture();await f.machine.start();await f.machine.poll();f.set({status:'delivered'});await f.machine.poll();expect(f.accepts).toBe(0);expect(f.machine.status.confirmed).toBe(false);await f.machine.confirmCode(false);expect(f.machine.status.phase).toBe('cancelled');expect(f.accepts).toBe(0);
});
test('R6 pairing SAS binds secret/session/user; R9 equivalent SPKI Base64 compares by DER',async()=>{
 const {pairingSas,canonicalSpki}=await import('../../src/cloud/v2');const secret=keys[0],session='pair';const digest=createHmac('sha256',secret).update(lengthPrefix('watchrss/pairing-sas/v2',session,u)).digest();const expected=(digest.readBigUInt64BE(0)%100000000n).toString().padStart(8,'0');expect(await pairingSas(crypto,secret,session,u)).toBe(expected);expect(await pairingSas(crypto,secret,'other',u)).not.toBe(expected);expect(await pairingSas(crypto,secret,session,'other')).not.toBe(expected);expect(canonicalSpki(t.publicKeySpki.replace(/=+$/,''))).toBe(t.publicKeySpki);
});

test('R10 logout attempts revoke before cleanup and continues after a failed remote revoke',async()=>{
 const values=new Map<string,string>(),events:string[]=[];const store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{events.push('session');values.delete(k);},revokeCloudScope:async()=>{events.push('revoke');throw Error('offline');},clearCloudScope:async()=>{events.push('cloud');}});await store.save(account('A'));await store.clear();expect(events).toEqual(['revoke','session','cloud']);expect(await store.read()).toBeNull();
 const {revokeAccountCloud}=await import('../../src/account/cloud-cleanup');const requests:any[]=[];await revokeAccountCloud(async<T>(method:string)=>{expect(method).toBe('sql.query');return[{device_id:'watch'}] as T;},account('A'),{request:async r=>{requests.push(r);return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(r.url.endsWith('/bootstrap')?{member:{},libraryEpoch:e,keyVersionFloor:0,keyCommitments:[],devices:[],keyEnvelopes:[]} : {}))};}});expect(requests[1].url).toEndWith('/cloud/devices/watch/revoke');expect(requests[1].headers['x-watchrss-library-epoch']).toBe(e);
});
test('R7 QR key delivery requires a single payload string and rejects UTF-8 bytes over 14 KiB',async()=>{
 const {WatchSetupHandler}=await import('../../src/onboarding/watch-setup');let deliveries=0,shown='';const handler=new WatchSetupHandler({deviceId:'watch',installId:'install',now:()=>1,active:()=>true,pairing:{sessionId:'pair',secret:keys[0]},crypto,confirm:async(_label,sas)=>{shown=sas;return true;},readAccount:async()=>null,saveAccount:async()=>{},publicKey:async()=>t.publicKeySpki,verifiedReady:async()=>false,currentKeyVersion:async()=>0,trust:async()=>trust,acceptDelivery:async()=>{deliveries++;},parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});await handler.handle({action:'prepare',userId:u});expect(shown).toHaveLength(8);await handler.handle({action:'configure',account:{userId:u,installId:'install',backendBaseUrl:'https://sly-data-plane.watchrss.cn',watchAccessToken:'token',accessTokenExpiresAt:9999,watchRefreshToken:'refresh'}});await expect(handler.handle({action:'key',userId:u,payload:'中'.repeat(5000)})).rejects.toThrow('pairing_payload_too_large');expect(deliveries).toBe(0);
});

test('R1 background bootstrap cannot bypass local approval confirmation by importing delivered server envelopes',async()=>{
 const f=manager();const remote=envelopes.map((envelope,i)=>({id:String(i),recipientType:'device',recipientDeviceId:t.deviceId,envelope}));expect(await f.manager.acceptBootstrap(u,t.deviceId,remote,trust,attestation)).toBe('waiting-approval');expect(await f.manager.accountKey(u)).toBeUndefined();expect(f.store.values.size).toBe(0);await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation);expect(await f.manager.currentKeyVersion(u)).toBe(3);
});

test('L PodJS identity excludes entitlement and access-token changes',async()=>{
 const {cloudAccountIdentity}=await import('../../src/cloud/identity');const a=account('A');expect(cloudAccountIdentity({...a,entitlement:{...a.entitlement,plan:'member'},watchDeviceToken:'rotated'} as typeof a)).toBe(cloudAccountIdentity(a));expect(cloudAccountIdentity(account('B'))).not.toBe(cloudAccountIdentity(a));expect(cloudAccountIdentity({...a,backendBaseUrl:'https://other.test'})).not.toBe(cloudAccountIdentity(a));
});
test('R9 approval accepts equivalent DER when relay normalizes Base64 padding',async()=>{
 const f=approvalFixture();await f.machine.start();await f.machine.poll();f.responses.publicKeySpki=f.responses.publicKeySpki.replace(/=+$/,'');f.responses.approverSpki=f.responses.approverSpki.replace(/=+$/,'');await f.machine.poll();expect(f.machine.status.phase).toBe('code');expect(f.accepts).toBe(0);
});

test('library epoch persists at account scope across changed device identities and clears all old device states',async()=>{
 const store=new Store(),one=new WatchCloudStateStore(store,u,'old-device',guard,'https://backend.test'),two=new WatchCloudStateStore(store,u,'new-device',guard,'https://backend.test');await one.acceptEpoch(e);await one.markApplied('phone',77,true);expect(await two.acceptEpoch('00000000-0000-4000-8000-000000000000')).toBe(true);expect(await one.applied('phone',true)).toBe(0);
});

test('epoch-proxy PUT binds the reservation URL, raw ciphertext, fresh bearer and epoch; 409 clears scope',async()=>{
 const requests:any[]=[],data=new Uint8Array(4*1024*1024+1).fill(7),hash=await crypto.sha256(data);let mismatch=false,cleared=0;
 const client=new WatchCloudClient({request:async r=>{requests.push(r);return{status:mismatch?409:204,headers:{},body:new TextEncoder().encode(mismatch?'{"error":"library_epoch_mismatch"}':'')};}},{baseUrl:'https://backend.test',accessToken:'old',refreshToken:async()=> 'fresh',onEpochMismatch:async()=>{cleared++;}},crypto,guard);client.setEpoch(e);
 const target={transport:'epoch-proxy',uploadMethod:'PUT',reservationId:'r1',uploadUrl:'https://backend.test/functions/v1/cloud/uploads/r1',signedUrl:'https://backend.test/functions/v1/cloud/uploads/r1',kind:'chunk',sha256:hash,sizeBytes:data.length,objectPath:'opaque',token:'',tusEndpoint:'',bucketName:''};await client.uploadObject(target,data);expect(requests[0]).toMatchObject({method:'PUT',headers:{authorization:'Bearer fresh','content-type':'application/octet-stream','x-watchrss-library-epoch':e}});expect(requests[0].body).toEqual(data);
 for(const bad of [{...target,transport:'tus'},{...target,uploadUrl:'https://other.test/functions/v1/cloud/uploads/r1'},{...target,uploadUrl:'https://backend.test/functions/v1/cloud/uploads/r1?leak=1'},{...target,reservationId:'other'}])await expect(client.uploadObject(bad,data)).rejects.toThrow('上传目标');expect(requests).toHaveLength(1);mismatch=true;await expect(client.uploadObject(target,data)).rejects.toThrow('library_epoch_mismatch');expect(cleared).toBe(1);
});

test('review M2/R23: server expiry survives slow/fast clocks and forward/backward wall-clock jumps',async()=>{
 for(const time of [-86400000,1,86400000]){const f=approvalFixture();f.set({time});await f.machine.start();expect(f.machine.expiresAt).toBe(300001);await f.machine.poll();expect(f.machine.status.phase).toBe('code');f.set({time:-time+999999999});await f.machine.confirmCode(true);expect(f.machine.status.phase).toBe('code');expect(f.reveals).toBeGreaterThan(0);}
 for(const signal of ['status','http']){const f=approvalFixture();await f.machine.start();await f.machine.poll();if(signal==='status'){f.set({status:'expired'});await f.machine.poll();}else{f.set({error:'Cloud HTTP 409 approval_expired'});await expect(f.machine.poll()).rejects.toThrow('approval_expired');}expect(f.machine.status.phase).toBe('expired');const gets=f.gets;await f.machine.poll();expect(f.gets).toBe(gets);expect(f.accepts).toBe(0);}
});
test('R23: real client preserves approval_expired from create/get/reveal as a server expiry signal',async()=>{
 const client=new WatchCloudClient({request:async()=>({status:409,headers:{},body:new TextEncoder().encode('{"error":"approval_expired"}')})},{baseUrl:'https://backend.test',accessToken:'token'},crypto,guard);client.setEpoch(e);
 for(const call of [()=>client.approvalCreate(t.deviceId,a.commitment),()=>client.approvalGet(a.requestId),()=>client.approvalReveal(a.requestId,t.requesterNonce)])await expect(call()).rejects.toThrow('Cloud HTTP 409 approval_expired');
 const f=new WatchCloudApproval({userId:u,deviceId:t.deviceId,trust,crypto,keys:manager().manager,client,now:()=>-86400000,assertCurrent:async()=>{}});await expect(f.start()).rejects.toThrow('approval_expired');expect(f.status.phase).toBe('expired');
});
test('R22: background pauses polls without losing requester nonce or pinned approver',async()=>{
 const f=approvalFixture();await f.machine.start();f.machine.setForeground(false);await f.machine.poll();expect(f.gets).toBe(0);f.machine.setForeground(true);await f.machine.poll();expect(f.machine.status.code).toBe(a.code);
 const gets=f.gets;f.machine.setForeground(false);f.set({time:999999999});await f.machine.poll();expect(f.gets).toBe(gets);f.machine.setForeground(true);f.set({status:'revealed'});await f.machine.poll();expect(f.machine.status).toEqual({phase:'code',code:a.code,confirmed:false});await f.machine.confirmCode(true);expect(f.machine.status.confirmed).toBe(true);
 f.machine.setForeground(false);f.responses.approverDeviceId='changed';await f.machine.poll();f.machine.setForeground(true);await expect(f.machine.poll()).rejects.toThrow('approval_approver_changed');expect(f.accepts).toBe(0);
});
test('review low 7: failed new versions retain revalidated old keys, remove obsolete quarantine, and retry fresh envelopes',async()=>{
 const oldAttest={keyVersion:1,mac:await attest(crypto,keys[0],u,e,t.deviceId,t.publicKeySpki)};
 for(const mode of ['missing','proof','envelope','attest','delivery','restart']){
  const f=manager();await f.manager.acceptDelivery(u,t.deviceId,envelopes.slice(0,1),{...trust,keyCommitments:trust.keyCommitments.slice(0,1)},oldAttest);
  const slot=[...f.store.values.keys()].find(k=>k.endsWith('.1'))!,quarantine=slot.slice(0,-(e.length+2))+'quarantine';await f.store.set(quarantine,'{"reason":"rotation_proof_invalid"}');
  if(mode==='restart')f.manager=manager(f.store).manager;
  const tr=structuredClone(trust);if(mode==='proof')tr.keyCommitments[2].rotationProof=vectors.negative.rotationProof3_with_wrong_prev;
  const candidate=mode==='missing'||mode==='delivery'||mode==='restart'?[envelopes[2]]:mode==='envelope'?[{...envelopes[1],nonceBase64:''}]:envelopes.slice(1);
  const remote=candidate.map((envelope,i)=>({id:String(i),recipientType:'device',recipientDeviceId:t.deviceId,envelope}));
  await expect(mode==='delivery'?f.manager.acceptDelivery(u,t.deviceId,candidate,tr,attestation):f.manager.acceptBootstrap(u,t.deviceId,remote,tr,mode==='attest'?{...oldAttest,mac:'0'.repeat(64)}:oldAttest)).rejects.toThrow();
  expect(await f.manager.keyVersions(u)).toEqual([1]);expect(await f.manager.currentKeyVersion(u)).toBe(1);expect(await f.manager.accountKey(u,1)).toEqual(keys[0]);expect(await f.manager.accountKey(u,3)).toBeUndefined();expect(f.store.values.has(quarantine)).toBe(false);expect([...f.store.values.keys()].filter(k=>k.includes(e))).toHaveLength(1);
  expect(await f.manager.acceptBootstrap(u,t.deviceId,envelopes.slice(1).map((envelope,i)=>({id:String(i),recipientType:'device',recipientDeviceId:t.deviceId,envelope})),trust,oldAttest)).toBe('ready');expect(await f.manager.keyVersions(u)).toEqual([1,2,3]);expect(await manager(f.store).manager.acceptBootstrap(u,t.deviceId,[],trust,oldAttest)).toBe('ready');
 }
});
test('review low 7/R20: rewritten old proof retains only its valid prefix; commitment mismatch still clears every account key but preserves device identity',async()=>{
 const f=manager();await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation);const spki=await f.manager.publicKeySpki(u,t.deviceId),badProof=structuredClone(trust);badProof.keyCommitments[1].rotationProof='0'.repeat(64);await expect(f.manager.acceptBootstrap(u,t.deviceId,[],badProof,attestation)).rejects.toThrow('rotation_proof_invalid');expect(await f.manager.keyVersions(u)).toEqual([1]);
 const badCommit=structuredClone(trust);badCommit.keyCommitments[2].commitment='0'.repeat(64);await expect(f.manager.acceptBootstrap(u,t.deviceId,[],badCommit,attestation)).rejects.toThrow('library_epoch_mismatch');expect(await f.manager.keyVersions(u)).toEqual([]);expect(f.store.values.size).toBe(0);expect(await f.manager.publicKeySpki(u,t.deviceId)).toBe(spki);
});
test('R21: failed legacy migration preserves the original keys until authenticated upgrade succeeds',async()=>{
 const f=manager(),name='watchrss.cloud.keys.'+await crypto.sha256(new TextEncoder().encode(u)),raw=JSON.stringify(Object.fromEntries(keys.map((k,i)=>[i+1,Buffer.from(k).toString('base64')])));await f.store.set(name,raw);
 const bad=structuredClone(trust);bad.keyCommitments[2].rotationProof='0'.repeat(64);await expect(f.manager.acceptBootstrap(u,t.deviceId,[],bad,attestation)).rejects.toThrow('rotation_proof_invalid');expect(await f.store.get(name)).toBe(raw);expect(await f.manager.acceptBootstrap(u,t.deviceId,[],trust,attestation)).toBe('ready');expect(await f.store.get(name)).toBeUndefined();
});
test('R20: only confirmed re-registration revokes self, clears account trust and registers the preserved device key',async()=>{
 const {createCloudAuthorization}=await import('../../src/cloud/authorization');const f=manager();await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation);const calls:string[]=[];let revoked=false,conflict=false;
 const client=new WatchCloudClient({request:async r=>{const path=new URL(r.url).pathname;calls.push(path);if(path.endsWith('/revoke'))revoked=true;if(path.endsWith('/register')){if(conflict)return{status:409,headers:{},body:new TextEncoder().encode('{"error":"device_key_conflict"}')};revoked=false;}return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(path.endsWith('/bootstrap')?{...trust,member:{},devices:[{deviceId:t.deviceId,publicKeySpki:t.publicKeySpki,revokedAt:revoked?'now':null}],keyEnvelopes:[]}:{}))};}},{baseUrl:'https://backend.test',accessToken:'token'},crypto,guard);
 const state=new WatchCloudStateStore(f.store,u,t.deviceId,guard,'https://backend.test');await state.acceptEpoch(e);const auth=createCloudAuthorization({userId:u,deviceId:t.deviceId,client,keys:f.manager,state,crypto,assertCurrent:async()=>{},invalidate:async()=>{calls.push('clear-account');await f.manager.clear(u);}});
 await expect(auth.reregister(false)).rejects.toThrow('confirmation');expect(calls).toEqual([]);await auth.reregister(true);expect(calls).toEqual(['/functions/v1/cloud/bootstrap',`/functions/v1/cloud/devices/${t.deviceId}/revoke`,'clear-account','/functions/v1/cloud/devices/register','/functions/v1/cloud/bootstrap']);expect(await f.manager.currentKeyVersion(u)).toBe(0);expect(await auth.publicKey()).toBe(t.publicKeySpki);conflict=true;await expect(auth.reregister(true)).rejects.toThrow('device_key_conflict: 重新登记本机');
});


test('R22: background during an in-flight poll retains the session after a transport interruption',async()=>{
 const f=approvalFixture();await f.machine.start();let finish!:()=>void;f.set({getWait:new Promise<void>(resolve=>{finish=resolve;})});const running=f.machine.poll();for(let i=0;i<10&&!f.gets;i++)await Promise.resolve();expect(f.gets).toBe(1);f.machine.setForeground(false);f.set({error:'network interrupted'});finish();await running;expect(f.machine.status.phase).toBe('pending');f.set({error:'',getWait:Promise.resolve()});f.machine.setForeground(true);await f.machine.poll();expect(f.machine.status.code).toBe(a.code);expect(f.reveals).toBe(1);
});


test('authenticated delivery still requires every envelope even when all old versions are already cached',async()=>{
 const f=manager();await f.manager.acceptDelivery(u,t.deviceId,envelopes,trust,attestation);await expect(f.manager.acceptDelivery(u,t.deviceId,[envelopes[2]],trust,attestation)).rejects.toThrow('missing_key_version');expect(await f.manager.keyVersions(u)).toEqual([1,2,3]);
});
