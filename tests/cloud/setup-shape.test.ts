import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {createHash,createHmac,generateKeyPairSync,diffieHellman,createPublicKey,hkdfSync,createDecipheriv} from 'node:crypto';
import {WatchSetupHandler} from '../../src/onboarding/watch-setup';
import {WatchCloudKeyManager,type CloudStringStore} from '../../src/cloud/keys';
import vectors from './fixtures/v2-vectors.json';

// Run the peer's production caller, including its receipt checks and relay-size codec.
// The sibling cloud-v2 worktree is read-only; no wx APIs or network ports are used.
const require=createRequire(import.meta.url),miniRoot=new URL('../../../WatchRSS_WeChat.wt-cloud-v2/miniprogram/lib/',import.meta.url).pathname;
const mini=require(miniRoot+'watch-setup.js'),miniCrypto=require(miniRoot+'crypto.js'),util=require(miniRoot+'util.js'),envelope=require(miniRoot+'envelope.js');
const crypto={sha256:async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
const userId=vectors.inputs.userId,deviceId=vectors.approval.requesterDeviceId,installId='22222222-2222-4222-8222-222222222222';
const keys=[vectors.inputs.K1_hex,vectors.inputs.K2_hex,vectors.inputs.K3_hex].map(k=>new Uint8Array(Buffer.from(k,'hex')));
const trust={libraryEpoch:vectors.inputs.libraryEpoch,keyVersionFloor:0,keyCommitments:keys.map((_,i)=>({keyVersion:i+1,commitment:(vectors.commit as any)[i+1],rotationProof:i?(vectors.rotationProof as any)[i+1]:null}))};
class Store implements CloudStringStore {values=new Map<string,string>();async get(k:string){return this.values.get(k);}async set(k:string,v:string){this.values.set(k,v);}async update(values:Record<string,string|null>){for(const [k,v]of Object.entries(values))if(v===null)this.values.delete(k);else this.values.set(k,v);}}

test('review M1: production mini configure accepts PodJS/native receipt shapes; dropped userId/keyVersion are detected',async()=>{
 for(const omit of ['', 'userId', 'keyVersion']){
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),values=new Store();
  const manager=new WatchCloudKeyManager({...crypto,publicKey:async()=>publicKeySpki,unwrap:async a=>{
   const shared=diffieHellman({privateKey:pair.privateKey,publicKey:createPublicKey({key:Buffer.from(a.publicKeySpki,'base64'),type:'spki',format:'der'})});
   const key=new Uint8Array(hkdfSync('sha256',shared,Buffer.from(a.saltBase64,'base64'),Buffer.from(a.infoBase64,'base64'),32));shared.fill(0);
   try{const ciphertext=Buffer.from(a.ciphertextBase64,'base64'),d=createDecipheriv('aes-256-gcm',key,Buffer.from(a.nonceBase64,'base64'));d.setAAD(Buffer.from(a.aadBase64,'base64'));d.setAuthTag(ciphertext.subarray(-16));return new Uint8Array(Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]));}finally{key.fill(0);}
  }},values,{require(){}},'https://sly-data-plane.watchrss.cn');
  let saved=false,attestation:any,shownSas='';const stored:any[]=[],receipts:Record<string,any>={};
  const verifiedReady=async()=>await manager.acceptBootstrap(userId,deviceId,stored,trust,attestation)==='ready';
  const handler=new WatchSetupHandler({deviceId,installId,now:Date.now,active:()=>true,crypto,pairing:{sessionId:'abcdefghijklmnopqrstuv',secret:keys[0]},confirm:async(_label,sas)=>{shownSas=sas;return true;},readAccount:async()=>null,saveAccount:async()=>{saved=true;},publicKey:async()=>publicKeySpki,verifiedReady,currentKeyVersion:()=>manager.currentKeyVersion(userId),trust:async()=>trust,acceptDelivery:async(_user,envelopes,trust,attestation)=>manager.acceptDelivery(userId,deviceId,envelopes,trust,attestation),parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});
  const descriptor={sessionId:'abcdefghijklmnopqrstuv',secret:Buffer.from(keys[0]).toString('base64'),deviceId,installId};
  const session={userId,accessToken:'mini-only-token',phoneMasked:'138****0000'},requests:any[]=[];
  const ports={account:{getUsableSession:()=>session},appaccess:{request:async(r:any)=>{requests.push(r);if(r.path.endsWith('/register')){attestation={keyVersion:r.body.attestationKeyVersion,mac:r.body.attestation};return{data:{}};}return{data:{watchAccessToken:'watch-only-token',watchRefreshToken:'watch-refresh',accessTokenExpiresAt:Date.now()+60000}};}},sync:{bootstrap:async()=>({...trust,devices:[{deviceId:'mini-device'}],keyEnvelopes:stored}),resolveAccountKey:()=>({}),currentKeyVersion:()=>3,getAccountKey:(_u:string,v:number)=>keys[v-1].slice(),storeKeyEnvelope:async(_type:string,_recipient:string,_sender:string,envelope:any)=>{stored.push({id:String(stored.length),recipientType:'device',recipientDeviceId:deviceId,envelope});}},device:{deviceId:()=>'mini-device'},crypto:miniCrypto,util,envelope,config:{backendBaseUrl:'https://sly-data-plane.watchrss.cn'}};
  const run=mini.configure(descriptor,{request:async(r:any)=>{const receipt=await handler.handle(r);receipts[r.action]={...receipt};if(r.action==='configure'&&omit==='userId')delete receipt.userId;if(r.action==='key'&&omit==='keyVersion')delete receipt.keyVersion;return receipt;}},()=>{},ports);
  if(omit==='userId'){await expect(run).rejects.toThrow('手表尚未确认保存账号');expect(saved).toBe(true);expect(receipts.key).toBeUndefined();continue;}
  const result=await run;expect(saved).toBe(true);expect(shownSas).toBe(result.sas);
  expect(receipts.configure).toEqual({success:true,bound:true,deviceId,userId,cloudReady:false});
  expect(receipts.key).toEqual({success:true,cloudReady:true,deviceId,keyVersion:3});
  expect(await manager.keyVersions(userId)).toEqual([1,2,3]);for(let i=1;i<=3;i++)expect(await manager.accountKey(userId,i)).toEqual(keys[i-1]);
  expect(result.cloudReady).toBe(omit!=='keyVersion');expect(result.cloudError).toBe(omit==='keyVersion');if(!omit)expect(receipts.finish.cloudReady).toBe(true);
  expect(JSON.stringify(requests)).not.toContain(session.accessToken);
 }
});
