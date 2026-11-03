import {test,expect} from 'bun:test';
import {createHash,createHmac,createPublicKey,createCipheriv,createDecipheriv,createECDH,hkdfSync,randomBytes,verify} from 'node:crypto';
import {CloudApproverController} from '../../src/cloud/approver-controller';
import {createApproverCrypto} from '../../src/cloud/approver-crypto';
import {CloudRequestError,WatchCloudClient} from '../../src/cloud/client';
import {createCloudAuthorization} from '../../src/cloud/authorization';
import {attest,verifyDelivery,type ApprovalTranscript} from '../../src/cloud/v2';
import type {ApproverSession,PendingApproval} from '../../src/cloud/approver';
import {contentFixture} from './content-fixture';
import vectors from './fixtures/v2-vectors.json';
const a=vectors.approval,u=vectors.inputs.userId,epoch=vectors.inputs.libraryEpoch;
const b64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
const hash=async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const nodeCrypto={sha256:hash,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex'),random:async()=>b64(a.approverNonce_b64),verify:async(spki:Uint8Array,b:Uint8Array,sig:Uint8Array)=>verify('sha256',b,{key:createPublicKey({key:Buffer.from(spki),type:'spki',format:'der'}),dsaEncoding:'ieee-p1363'},sig)};
function cryptoPorts(){let draws=0;return {
 sha256:hash,random:async(n:number)=>new Uint8Array(++draws===1?Buffer.from(a.approverPrivateScalar_hex,'hex'):randomBytes(n)),
 hkdf:async(k:Uint8Array,salt:Uint8Array,info:Uint8Array)=>new Uint8Array(hkdfSync('sha256',k,salt,info,32)),
 encrypt:async(k:Uint8Array,aad:Uint8Array,input:Uint8Array)=>{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k,nonce);cipher.setAAD(aad);return {nonce,ciphertext:Buffer.concat([cipher.update(input),cipher.final(),cipher.getAuthTag()])};},
};}
function fixture(){
 const target:PendingApproval={requestId:a.requestId,deviceId:a.requesterDeviceId,displayName:'Phone',publicKeySpki:a.requesterSpki_b64,commitment:a.commitment,expiresAt:300001};
 const row:any={...target,status:'pending',requesterNonce:null};
 const keys=[vectors.inputs.K1_hex,vectors.inputs.K2_hex,vectors.inputs.K3_hex].map(s=>new Uint8Array(Buffer.from(s,'hex')));
 const trust={...contentFixture,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:keys.map((_,i)=>({keyVersion:i+1,commitment:(vectors.commit as any)[i+1],rotationProof:i?(vectors.rotationProof as any)[i+1]:null})),devices:[],keyEnvelopes:[],member:{} as any};
 let pendingError:Error|undefined,getError:Error|undefined,deliverError:Error|undefined,scope='backend/user',current=true,hasKey=true,openGate:Promise<void>|undefined,getGate:Promise<void>|undefined,wrapGate:Promise<void>|undefined;
 let opens=0,pending=0,accepts=0,gets=0,cancels=0,reads=0,wraps=0;const deliveries:{payload:string;signature:string}[]=[],copies:Uint8Array[]=[];
 const crypto=createApproverCrypto(cryptoPorts()),suite={...crypto,wrap:async(...args:Parameters<typeof crypto.wrap>)=>{wraps++;await wrapGate;return crypto.wrap(...args);}};
 const controller=new CloudApproverController({crypto:suite,open:async check=>{opens++;await openGate;check();if(!hasKey)return undefined;const ownScope=scope;const s:ApproverSession={scope,userId:u,deviceId:a.approverDeviceId,trust,crypto:nodeCrypto,assertCurrent:async()=>{check();if(!current||ownScope!==scope)throw Error('cloud_account_changed');},keys:{accountKey:async(_user,v)=>{reads++;const k=keys[v!-1]?.slice();if(k)copies.push(k);return k;}},client:{approvalPending:async()=>{pending++;if(pendingError)throw pendingError;return {requests:[{...target}]};},approvalAccept:async(_id,device,spki,nonce)=>{accepts++;Object.assign(row,{status:'accepted',approverDeviceId:device,approverSpki:spki,approverNonce:nonce});},approvalGet:async()=>{gets++;await getGate;if(getError)throw getError;return {...row};},approvalCancel:async()=>{cancels++;row.status='cancelled';},approvalDeliver:async(_id,payload,signature)=>{deliveries.push({payload,signature});Object.assign(row,{status:'delivered',payload,signature});if(deliverError)throw deliverError;}}};return s;}});
 controller.setForeground(true);
 return {controller,row,target,trust,keys,deliveries,copies,reveal(){row.status='revealed';row.requesterNonce=a.requesterNonce_b64;},set(p:{pendingError?:Error;getError?:Error;deliverError?:Error;scope?:string;current?:boolean;hasKey?:boolean;openGate?:Promise<void>;getGate?:Promise<void>;wrapGate?:Promise<void>}){pendingError=p.pendingError;getError=p.getError;deliverError=p.deliverError;scope=p.scope??scope;current=p.current??current;hasKey=p.hasKey??hasKey;openGate=p.openGate;getGate=p.getGate;wrapGate=p.wrapGate;},get calls(){return {opens,pending,accepts,gets,cancels,reads,wraps};}};
}
async function comparing(f:ReturnType<typeof fixture>){await f.controller.poll();expect(await f.controller.accept(a.requestId)).toBe(true);f.reveal();expect(await f.controller.poll()).toBe(true);}

test('approver discovers without accepting and shows the shared 8-digit vector only after reveal',async()=>{
 const f=fixture();await f.controller.poll();expect(f.controller.state).toMatchObject({phase:'requested',requests:[{requestId:a.requestId,requesterLabel:'Phone',expiresAt:300001}]});expect(f.calls.accepts).toBe(0);expect(f.calls.reads).toBe(0);
 await f.controller.accept(a.requestId);await f.controller.poll();expect(f.controller.state.phase).toBe('waiting');expect(f.controller.state.code).toBeUndefined();expect(await f.controller.confirm(true)).toBe(false);
 f.reveal();await f.controller.poll();expect(f.controller.state).toMatchObject({phase:'code',code:a.code,requesterLabel:'Phone'});expect(f.deliveries).toHaveLength(0);expect(f.calls.wraps).toBe(0);
});
test('agreement delivers ALL committed versions, exact signed payload and highest-version attestation',async()=>{
 const f=fixture();await comparing(f);expect(await f.controller.confirm(true)).toBe(true);expect(f.controller.state.phase).toBe('complete');expect(f.deliveries).toHaveLength(1);
 const {payload,signature}=f.deliveries[0],decoded=JSON.parse(payload);expect(decoded.envelopes.map((r:any)=>r.keyVersion)).toEqual([1,2,3]);
 for(const {keyVersion,envelope} of decoded.envelopes){expect(envelope).toMatchObject({keyVersion,recipientType:'device',recipientDeviceId:a.requesterDeviceId,createdByDeviceId:a.approverDeviceId,algorithm:'P-256+HKDF-SHA256+A256GCM'});expect(b64(envelope.wrappedKeyBase64)).toHaveLength(48);expect(b64(envelope.nonceBase64)).toHaveLength(12);}
 expect(decoded.attestation).toEqual({keyVersion:3,mac:vectors.attest.mac});
 const t:ApprovalTranscript={userId:u,libraryEpoch:epoch,requestId:a.requestId,deviceId:a.requesterDeviceId,publicKeySpki:a.requesterSpki_b64,approverDeviceId:a.approverDeviceId,approverSpki:a.approverSpki_b64,requesterNonce:a.requesterNonce_b64,approverNonce:a.approverNonce_b64};
 expect(await verifyDelivery(nodeCrypto,t,payload,signature)).toBe(true);expect(await verifyDelivery(nodeCrypto,t,payload+' ',signature)).toBe(false);expect(f.copies.every(k=>k.every(b=>b===0))).toBe(true);expect(await f.controller.confirm(true)).toBe(false);
});
test('noble envelopes decrypt with independent Node ECDH/HKDF/AES-GCM using requester private key',async()=>{
 const requester=createECDH('prime256v1');requester.generateKeys();const point=requester.getPublicKey(undefined,'uncompressed'),spki=Buffer.concat([Buffer.from(a.requesterSpki_b64,'base64').subarray(0,26),point]).toString('base64');
 const key=new Uint8Array(randomBytes(32)),suite=createApproverCrypto(cryptoPorts());
 for(const version of [1,3]){const envelope=await suite.wrap(key,u,'requester',spki,version),secret=requester.computeSecret(Buffer.from(envelope.ephemeralPublicKeySpki!,'base64').subarray(26)),wrapping=hkdfSync('sha256',secret,createHash('sha256').update(u).digest(),Buffer.from(`watchrss/device-envelope/v${version}/requester`),32),wrapped=Buffer.from(envelope.wrappedKeyBase64,'base64'),cipher=createDecipheriv('aes-256-gcm',Buffer.from(wrapping),Buffer.from(envelope.nonceBase64,'base64'));cipher.setAAD(Buffer.from(`watchrss-account-key:${u}:${version}:requester`));cipher.setAuthTag(wrapped.subarray(-16));expect(Buffer.concat([cipher.update(wrapped.subarray(0,-16)),cipher.final()])).toEqual(Buffer.from(key));}
});
test('disagreement cancels server request without reading any account key',async()=>{const f=fixture();await comparing(f);expect(await f.controller.confirm(false)).toBe(true);expect(f.controller.state.phase).toBe('cancelled');expect(f.calls.cancels).toBe(1);expect(f.calls.reads).toBe(0);expect(f.deliveries).toHaveLength(0);});
for(const field of ['commitment','publicKeySpki','deviceId','approverDeviceId','approverNonce','requesterNonce','expiresAt'])test(`changed ${field} fails closed before wrapping/delivery`,async()=>{const f=fixture();await comparing(f);f.row[field]=field==='expiresAt'?1:field==='publicKeySpki'?a.approverSpki_b64:'changed';expect(await f.controller.confirm(true)).toBe(false);expect(f.controller.state.phase).toBe('error');expect(f.calls.wraps).toBe(0);expect(f.deliveries).toHaveLength(0);});
for(const status of ['expired','cancelled'] as const)test(`server ${status} clears comparison code`,async()=>{const f=fixture();await comparing(f);f.row.status=status;await f.controller.poll();expect(f.controller.state.phase).toBe(status);expect(f.controller.state.code).toBeUndefined();expect(f.deliveries).toHaveLength(0);});
test('server approval_expired error maps to expired without keys or nonce in state',async()=>{const f=fixture();await comparing(f);f.set({getError:new CloudRequestError(409,'approval_expired')});await f.controller.poll();expect(f.controller.state.phase).toBe('expired');});
test('old backend 403 becomes unsupported and never polls again on reopen',async()=>{const f=fixture();f.set({pendingError:new CloudRequestError(403,'phone_approval_required')});await f.controller.poll();expect(f.controller.state.phase).toBe('unsupported');const calls=f.calls;f.controller.setForeground(false);f.controller.setForeground(true);await f.controller.poll();expect(f.calls).toEqual(calls);});
test('background performs no IO, then resumes pinned code using a new session',async()=>{const f=fixture();await comparing(f);f.controller.setForeground(false);const calls=f.calls;await f.controller.poll();await f.controller.confirm(true);expect(f.calls).toEqual(calls);f.controller.setForeground(true);expect(await f.controller.poll()).toBe(true);expect(f.controller.state.code).toBe(a.code);});
test('late foreground response cannot publish a code after hide/resume',async()=>{const f=fixture();await f.controller.poll();await f.controller.accept(a.requestId);f.reveal();let release!:()=>void;f.set({getGate:new Promise(r=>release=r)});const pending=f.controller.poll();while(!f.calls.gets)await Promise.resolve();f.controller.setForeground(false);f.controller.setForeground(true);release();expect(await pending).toBe(false);expect(f.controller.state.code).toBeUndefined();f.set({});await f.controller.poll();expect(f.controller.state.code).toBe(a.code);});
test('account/backend or epoch change prevents approval continuation',async()=>{for(const kind of ['account','epoch']){const f=fixture();await comparing(f);if(kind==='account')f.set({scope:'another/backend'});else f.trust.libraryEpoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';expect(await f.controller.confirm(true)).toBe(false);expect(f.calls.wraps).toBe(0);expect(f.deliveries).toHaveLength(0);}});
test('watch without a verified key never calls pending',async()=>{const f=fixture();f.set({hasKey:false});await f.controller.poll();expect(f.calls.pending).toBe(0);expect(f.controller.state.phase).toBe('idle');});
test('cancel during key wrapping fences delivery and wipes returned key copies',async()=>{const f=fixture();await comparing(f);let release!:()=>void;f.set({wrapGate:new Promise(r=>release=r)});const confirm=f.controller.confirm(true);while(!f.calls.wraps)await Promise.resolve();const cancel=f.controller.cancel();expect(f.controller.state.phase).toBe('cancelled');release();expect(await confirm).toBe(false);await cancel;expect(f.deliveries).toHaveLength(0);expect(f.copies.every(k=>k.every(b=>b===0))).toBe(true);});
test('reset during open suppresses obsolete pending state and requests',async()=>{const f=fixture();let release!:()=>void;f.set({openGate:new Promise(r=>release=r)});const pending=f.controller.poll();f.controller.reset();release();await pending;expect(f.controller.state.phase).toBe('idle');expect(f.calls.pending).toBe(0);});
test('display state clones requests and never exposes nonces, public keys or account keys',async()=>{const f=fixture();await f.controller.poll();const state=f.controller.state;state.requests[0].requesterLabel='tampered';expect(f.controller.state.requests[0].requesterLabel).toBe('Phone');await f.controller.accept(a.requestId);f.reveal();await f.controller.poll();const raw=JSON.stringify(f.controller.state);for(const secret of [a.approverNonce_b64,a.requesterNonce_b64,a.approverSpki_b64,a.requesterSpki_b64,...f.keys.map(k=>Buffer.from(k).toString('base64'))])expect(raw).not.toContain(secret);});
test('approver endpoints preserve exact v2 bodies, encoded IDs and epoch headers',async()=>{
 const requests:any[]=[],client=new WatchCloudClient({request:async r=>{requests.push(r);return {status:200,headers:{},body:new TextEncoder().encode(r.method==='GET'?'{"requests":[]}':'{}')};}},{baseUrl:'https://backend.invalid',accessToken:'fixture'},nodeCrypto,{require(){}});client.setEpoch(epoch);
 await client.approvalPending();await client.approvalAccept('a/b','watch','spki','nonce');await client.approvalDeliver('a/b','{"literal":true}','sig');
 expect(requests.map(r=>[r.method,new URL(r.url).pathname])).toEqual([['GET','/functions/v1/cloud/approvals/v2/pending'],['POST','/functions/v1/cloud/approvals/v2/a%2Fb/accept'],['POST','/functions/v1/cloud/approvals/v2/a%2Fb/deliver']]);
 expect(JSON.parse(Buffer.from(requests[1].body).toString())).toEqual({approverDeviceId:'watch',approverSpki:'spki',approverNonce:'nonce'});expect(JSON.parse(Buffer.from(requests[2].body).toString())).toEqual({payload:'{"literal":true}',signature:'sig'});expect(requests[2].headers['x-watchrss-library-epoch']).toBe(epoch);
});
test('authorization discovery requires active own device, latest envelope and locally verified key',async()=>{
 for(const missing of ['device','envelope','key','none']){let verifies=0;const f=fixture(),trust={...f.trust,devices:missing==='device'?[]:[{deviceId:a.approverDeviceId,revokedAt:null}],keyEnvelopes:missing==='envelope'?[]:[{recipientType:'device',recipientDeviceId:a.approverDeviceId,envelope:{keyVersion:3}}]};
 const auth=createCloudAuthorization({userId:u,deviceId:a.approverDeviceId,client:{bootstrap:async()=>trust,setEpoch(){}} as any,keys:{acceptBootstrap:async()=>{verifies++;return missing==='key'?'waiting-approval':'ready';},currentKeyVersion:async()=>3} as any,state:{acceptEpoch:async()=>false} as any,crypto:nodeCrypto,assertCurrent:async()=>{},invalidate:async()=>{}});
 expect(!!await auth.approverSession('scope')).toBe(missing==='none');if(missing==='device'||missing==='envelope')expect(verifies).toBe(0);
 }
});

test('lost delivery response reconciles only the exact signed delivery, without a second POST',async()=>{const f=fixture();await comparing(f);f.set({deliverError:Error('connection lost')});expect(await f.controller.confirm(true)).toBe(true);expect(f.controller.state.phase).toBe('complete');expect(f.deliveries).toHaveLength(1);});
test('missing a historical key never sends a partial envelope batch',async()=>{const f=fixture();await comparing(f);f.keys.pop();expect(await f.controller.confirm(true)).toBe(false);expect(f.deliveries).toHaveLength(0);expect(f.copies.every(k=>k.every(b=>b===0))).toBe(true);});
test('requester cannot receive unexpected delivery before local approval',async()=>{const f=fixture();await comparing(f);f.row.status='delivered';f.row.payload='{}';f.row.signature='foreign';expect(await f.controller.poll()).toBe(false);expect(f.controller.state.phase).toBe('error');expect(f.calls.reads).toBe(0);});
test('runtime opts into the foreground approver factory without import-time host IO',async()=>{
 const {createCloudRuntime}=await import('../../src/cloud/runtime');
 let calls=0,created:CloudApproverController|undefined;
 const host=async<T>():Promise<T>=>{calls++;throw Error('unexpected host IO');},repo=async()=>{calls++;throw Error('unexpected repository IO');},guard={require(){}};
 expect(createCloudRuntime(host,repo,guard).approver).toBeUndefined();
 const runtime=createCloudRuntime(host,repo,guard,undefined,undefined,undefined,{approver:(open,crypto)=>created=new CloudApproverController({open,crypto:createApproverCrypto(crypto)})});
 expect(runtime.approver).toBe(created);expect(runtime.approver?.active).toBe(false);expect(calls).toBe(0);
});
test('only the literal boolean true authorizes delivery',async()=>{const f=fixture();await comparing(f);for(const value of ['一致','false',1,null,undefined])expect(await f.controller.confirm(value as any)).toBe(false);expect(f.calls.reads).toBe(0);expect(f.calls.cancels).toBe(0);expect(f.deliveries).toHaveLength(0);expect(f.controller.state.phase).toBe('code');});
