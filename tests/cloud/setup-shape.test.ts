import {test,expect} from 'bun:test';
import {createHash,createHmac,createPrivateKey,diffieHellman,createPublicKey,hkdfSync,createDecipheriv} from 'node:crypto';
import {WatchSetupHandler} from '../../src/onboarding/watch-setup';
import {WatchCloudClient} from '../../src/cloud/client';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {createCloudAuthorization} from '../../src/cloud/authorization';
import {WatchCloudKeyManager,type CloudStringStore} from '../../src/cloud/keys';
import fixture from './fixtures/setup-shape.json';
import vectors from './fixtures/v2-vectors.json';

const crypto={sha256:async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
class Store implements CloudStringStore {values=new Map<string,string>();async get(k:string){return this.values.get(k);}async set(k:string,v:string){this.values.set(k,v);}async update(values:Record<string,string|null>){for(const [k,v]of Object.entries(values))if(v===null)this.values.delete(k);else this.values.set(k,v);}}

test('review M1/recheck 13: frozen cross-client transcript matches every receipt with real ECIES and no sibling checkout',async()=>{
 const {userId,deviceId,installId,trust}=fixture,publicKeySpki=fixture.exchanges[0].response.publicKeySpki!,values=new Store();
 const privateKey=createPrivateKey({key:Buffer.from(fixture.receiverPrivateKeyPkcs8,'base64'),type:'pkcs8',format:'der'});
 const manager=new WatchCloudKeyManager({...crypto,publicKey:async()=>publicKeySpki,unwrap:async a=>{
  const shared=diffieHellman({privateKey,publicKey:createPublicKey({key:Buffer.from(a.publicKeySpki,'base64'),type:'spki',format:'der'})});
  const key=new Uint8Array(hkdfSync('sha256',shared,Buffer.from(a.saltBase64,'base64'),Buffer.from(a.infoBase64,'base64'),32));shared.fill(0);
  try{const ciphertext=Buffer.from(a.ciphertextBase64,'base64'),d=createDecipheriv('aes-256-gcm',key,Buffer.from(a.nonceBase64,'base64'));d.setAAD(Buffer.from(a.aadBase64,'base64'));d.setAuthTag(ciphertext.subarray(-16));return new Uint8Array(Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]));}finally{key.fill(0);}
 }},values,{require(){}},'https://sly-data-plane.watchrss.cn');
 let saved=false,delivered=false,registered=false;const operations:string[]=[];
 const delivery=JSON.parse(fixture.exchanges[2].request.payload!);
 const handler=new WatchSetupHandler({deviceId,installId,now:()=>fixture.now,active:()=>true,crypto,pairing:{sessionId:fixture.pairing.sessionId,secret:new Uint8Array(Buffer.from(fixture.pairing.secretBase64,'base64'))},confirm:async()=>true,readAccount:async()=>null,saveAccount:async()=>{saved=true;operations.push('save-account');},registerSelf:async account=>{
  expect(saved).toBe(true);const client=new WatchCloudClient({request:async r=>{expect(r.headers.authorization).toBe('Bearer '+account.watchDeviceToken);const registering=r.url.endsWith('/register');operations.push(registering?'register-self':'bootstrap');if(registering){expect(r.headers['x-watchrss-library-epoch']).toBe(trust.libraryEpoch);const body=JSON.parse(Buffer.from(r.body!).toString());expect(body).toMatchObject({deviceId,platform:'watch',publicKeySpki});expect(body.attestation).toBeUndefined();registered=true;}return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(registering?{}:{...trust,member:{},devices:registered?[{deviceId,publicKeySpki}]:[],keyEnvelopes:[]}))};}},{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken},crypto,{require(){}});
  const authorization=createCloudAuthorization({userId,deviceId,client,keys:manager,state:new WatchCloudStateStore(values,userId,deviceId,{require(){}},account.backendBaseUrl),crypto:{...crypto,random:async()=>new Uint8Array(),verify:async()=>false},assertCurrent:async()=>{expect(saved).toBe(true);},invalidate:async()=>manager.clear(userId)});await authorization.registerSelf();
 },publicKey:async()=>publicKeySpki,verifiedReady:async()=>{operations.push('verified-ready');return delivered&&await manager.acceptBootstrap(userId,deviceId,[],trust,delivery.attestation)==='ready';},currentKeyVersion:()=>manager.currentKeyVersion(userId),trust:async()=>trust,acceptDelivery:async(_user,envelopes,trust,attestation)=>{const result=await manager.acceptDelivery(userId,deviceId,envelopes,trust,attestation);delivered=result==='ready';return result;},parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});
 for(const exchange of fixture.exchanges){expect(await handler.handle(exchange.request)).toEqual(exchange.response);if(exchange.request.action==='configure')expect(operations).toEqual(fixture.expectedConfigureOperations);}
 expect(saved).toBe(true);expect(await manager.keyVersions(userId)).toEqual([1,2,3]);
 for(let i=1;i<=3;i++)expect(await manager.accountKey(userId,i)).toEqual(new Uint8Array(Buffer.from((vectors.inputs as any)['K'+i+'_hex'],'hex')));
});

test('frozen scanner receipt contract rejects missing userId and missing verified keyVersion',()=>{
 const bound=fixture.exchanges[1].response,key=fixture.exchanges[2].response;
 const acceptsBound=(r:Record<string,unknown>)=>r.userId===fixture.userId&&r.deviceId===fixture.deviceId&&r.bound===true;
 const acceptsKey=(r:Record<string,unknown>)=>r.deviceId===fixture.deviceId&&r.keyVersion===3&&r.cloudReady===true;
 expect(acceptsBound(bound)).toBe(true);expect(acceptsKey(key)).toBe(true);
 const missingUser={...bound};delete missingUser.userId;expect(acceptsBound(missingUser)).toBe(false);
 const missingVersion={...key};delete missingVersion.keyVersion;expect(acceptsKey(missingVersion)).toBe(false);
});

test('R28: configure awaits self-registration before bound; a failed registration keeps the account and permits retry',async()=>{
 let accountState:import('../../src/account/types').WatchAccountState|null=null,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),events:string[]=[];let fail=true,responded=false;
 const handler=new WatchSetupHandler({deviceId:fixture.deviceId,installId:fixture.installId,now:()=>fixture.now,active:()=>true,pairing:{sessionId:fixture.pairing.sessionId,secret:new Uint8Array(Buffer.from(fixture.pairing.secretBase64,'base64'))},crypto,confirm:async()=>true,readAccount:async()=>accountState,saveAccount:async state=>{accountState=state;events.push('save');},registerSelf:async state=>{expect(accountState?.watchDeviceToken).toBe(state.watchDeviceToken);events.push('register');await gate;if(fail)throw Error('Cloud HTTP 503');},publicKey:async()=>fixture.exchanges[0].response.publicKeySpki!,verifiedReady:async()=>{events.push('ready');return false;},currentKeyVersion:async()=>0,trust:async()=>fixture.trust,acceptDelivery:async()=>{},parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});
 await handler.handle(fixture.exchanges[0].request);const pending=handler.handle(fixture.exchanges[1].request);void pending.then(()=>{responded=true;},()=>{});for(let i=0;i<30&&!events.includes('register');i++)await Promise.resolve();expect(events).toEqual(['save','register']);expect(responded).toBe(false);await expect(handler.handle(fixture.exchanges[2].request)).rejects.toThrow('账号尚未绑定');release();await expect(pending).rejects.toThrow('503');expect(accountState).not.toBeNull();expect(events).not.toContain('ready');fail=false;expect(await handler.handle(fixture.exchanges[1].request)).toEqual(fixture.exchanges[1].response);expect(events).toEqual(['save','register','save','register','ready']);
});

test('R28: existing self-registration is reused only with matching DER; a conflicting server key requires local re-registration',async()=>{
 for(const same of [true,false]){const values=new Store(),spki=fixture.exchanges[0].response.publicKeySpki!,calls:string[]=[];const keys=new WatchCloudKeyManager({...crypto,publicKey:async()=>spki,unwrap:async()=>new Uint8Array(32)},values,{require(){}},'https://backend.invalid');
  const client=new WatchCloudClient({request:async r=>{calls.push(r.url);return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({...fixture.trust,member:{},keyEnvelopes:[],devices:[{deviceId:fixture.deviceId,publicKeySpki:same?spki.replace(/=+$/,''):vectors.approval.approverSpki_b64}]}))};}},{baseUrl:'https://backend.invalid',accessToken:'saved-watch-token'},crypto,{require(){}});
  const auth=createCloudAuthorization({userId:fixture.userId,deviceId:fixture.deviceId,client,keys,state:new WatchCloudStateStore(values,fixture.userId,fixture.deviceId,{require(){}},'https://backend.invalid'),crypto:{...crypto,random:async()=>new Uint8Array(),verify:async()=>false},assertCurrent:async()=>{},invalidate:async()=>{throw Error('must preserve identity until confirmed');}});
  if(same)await auth.registerSelf();else await expect(auth.registerSelf()).rejects.toThrow('device_key_conflict: 重新登记本机');expect(calls).toHaveLength(1);expect(calls[0]).toEndWith('/bootstrap');
 }
});
