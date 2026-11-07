import {test,expect} from 'bun:test';
import {hkdfSync,createHmac} from 'node:crypto';
import {unhex,hex,hkdfSha256Bytes} from '@podjs/framework/crypto';
import {framingAllowed} from '@podjs/framework/framing-boundary';
import {localProof,verifyLocalProof,LocalProofSession} from '../../src/sync-v2/local-proof';
import {objectCapability,chooseLocalProtocol,P4_CLOSED_GATES} from '../../src/sync-v2/local-capability';
import {scope,vector} from './fixture';
const v=vector('local-proof-c25'),key=unhex(v.derivation.repoKeyHex),base=v.cases[0].input;
test('C25 HKDF and LP transcript match independent fixed derivation',()=>{
 const actual=hkdfSha256Bytes(key,new Uint8Array(),new TextEncoder().encode(v.derivation.info));expect(hex(actual)).toBe(v.derivation.proofKeyHex);expect(Buffer.from(actual)).toEqual(Buffer.from(hkdfSync('sha256',key,new Uint8Array(),v.derivation.info,32)));
 expect(localProof(key,base.scope,base.sessionId,base.selfDeviceId,base.peerDeviceId,base.selfNonce,base.peerNonce)).toBe(v.transcript.proofBase64);expect(createHmac('sha256',actual).update(Buffer.from(v.transcript.lpHex,'hex')).digest('base64url')).toBe(v.transcript.proofBase64);
});
for(const c of v.cases)test('C25 fixed '+c.id,()=>{let error:string|null=null;try{verifyLocalProof(key,c.input);}catch(e){error=(e as Error).message;}expect({accepted:error===null,error}).toEqual(c.expected);});
test('two authenticated peers prove both directions and consume nonce once',async()=>{
 const a=new LocalProofSession(base.sessionId,key,{scope,deviceId:base.selfDeviceId,nonce:base.selfNonce,features:base.requiredFeatures},async()=> 'active',()=>true),b=new LocalProofSession(base.sessionId,key,{scope,deviceId:base.peerDeviceId,nonce:base.peerNonce,features:base.requiredFeatures},async()=> 'active',()=>true);
 await a.negotiate(b.hello);await b.negotiate(a.hello);expect(a.verified).toBe(false);expect(b.verified).toBe(false);await a.verify(b.proof(),base.requiredFeatures);await b.verify(a.proof(),base.requiredFeatures);expect(a.peerDeviceId).toBe(b.hello.deviceId);expect(b.peerDeviceId).toBe(a.hello.deviceId);await expect(a.verify(b.proof(),[])).rejects.toThrow('proof_invalid');a.close();expect(a.verified).toBe(false);
});
test('proof binds direction, session, scope and nonces',()=>{
 for(const patch of [{sessionId:'f'.repeat(32)},{selfDeviceId:base.peerDeviceId,peerDeviceId:base.selfDeviceId},{selfNonce:'f'.repeat(32)},{peerNonce:'e'.repeat(32)}])expect(()=>verifyLocalProof(key,{...base,...patch})).toThrow('proof_invalid');
});
test('revocation between hello and proof is rejected',async()=>{
 let status:'active'|'revoked'='active';const a=new LocalProofSession(base.sessionId,key,{scope,deviceId:base.peerDeviceId,nonce:base.peerNonce,features:base.requiredFeatures},async()=>status,()=>true);await a.negotiate({scope,deviceId:base.selfDeviceId,nonce:base.selfNonce,features:base.requiredFeatures});status='revoked';await expect(a.verify(base.proofBase64,base.requiredFeatures)).rejects.toThrow('member_revoked');expect(a.verified).toBe(false);
});
for(const [i,c] of vector('negotiation').cases.entries())test('negotiation fixed matrix '+i,()=>{
 const endpoint=(x:any)=>({legacyMax:x.legacyMax,capability:x.supportsSyncObjectsV2===undefined?undefined:{supportsSyncObjectsV2:x.supportsSyncObjectsV2,syncObjectsVersions:x.versions,requiredFeatures:x.required,supportedFeatures:x.supported,scope,maxPartBytes:65536}});
 expect(chooseLocalProtocol(endpoint(c.a),endpoint(c.b),c.scopeEqual,c.safeLegacy)).toBe(c.expected);
});
for(const c of vector('rc3-contracts').framing)test('fixed framing '+c.name,()=>expect(framingAllowed(c.input)).toBe(c.expected));
test('B08 fixed rejected; all P4 gates default closed',()=>{
 const b08=vector('rc3-review').cases.find((x:any)=>x.id==='B08');expect({enabled:framingAllowed(b08.input.state)}).toEqual(b08.expected);expect(Object.values(P4_CLOSED_GATES).every(x=>x===false)).toBe(true);expect(objectCapability(scope).supportsSyncObjectsV2).toBe(false);
});
