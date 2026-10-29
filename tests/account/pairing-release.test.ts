import {test,expect} from 'bun:test';
import {createHash,createPrivateKey,createPublicKey,diffieHellman,hkdfSync,createDecipheriv,createHmac} from 'node:crypto';
import {WatchAccountStore} from '../../src/account/store';
import {WatchLoginExpiredError} from '../../src/account/token';
import {possessionChallenge,releaseByPossession,replacePairingAccount,type PairingReleaseTarget} from '../../src/account/pairing-release';
import vectors from '../cloud/fixtures/pairing-ux-v1.json';
import type {WatchAccountState} from '../../src/account/types';
const sha=async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const target:PairingReleaseTarget={...vectors.context,check(){}};
const proof=async(a:any)=>{
 const privateKey=createPrivateKey({key:Buffer.from(vectors.receiverPrivateKeyPkcs8,'base64'),format:'der',type:'pkcs8'}),publicKey=createPublicKey({key:Buffer.from(a.publicKeySpki,'base64'),format:'der',type:'spki'}),shared=diffieHellman({privateKey,publicKey}),key=Buffer.from(hkdfSync('sha256',shared,Buffer.from(a.saltBase64,'base64'),Buffer.from(a.infoBase64,'base64'),32)),bytes=Buffer.from(a.ciphertextBase64,'base64'),d=createDecipheriv('aes-256-gcm',key,Buffer.from(a.nonceBase64,'base64'));d.setAAD(Buffer.from(a.aadBase64,'base64'));d.setAuthTag(bytes.subarray(-16));const secret=Buffer.concat([d.update(bytes.subarray(0,-16)),d.final()]);try{return{proofBase64:createHmac('sha256',secret).update(Buffer.from(a.dataBase64,'base64')).digest('base64')};}finally{secret.fill(0);shared.fill(0);key.fill(0);}
};
test('production proof codec matches deterministic shared transcript/host args and actual P256 crypto',async()=>{const parsed=await possessionChallenge(vectors.challenge,target,vectors.now,sha);expect(parsed.args).toEqual(vectors.proofArgs);expect(await proof(parsed.args)).toEqual({proofBase64:vectors.proofBase64});});
for(const mutate of ['target','expiry','padding','opaque','tail','field','extra'] as const)test('proof codec rejects '+mutate,async()=>{
 const c=structuredClone(vectors.challenge);if(mutate==='target')c.targetUserId='another';if(mutate==='expiry')c.expiresAtMillis=vectors.now+60001;if(mutate==='padding')c.saltBase64=c.saltBase64.replace(/=+$/,'');if(mutate==='extra')(c as any).oldUserId='must-not-exist';
 if(['opaque','tail','field'].includes(mutate)){const t=Buffer.from(c.transcriptBase64,'base64');if(mutate==='tail')c.transcriptBase64=Buffer.concat([t,Buffer.from([0])]).toString('base64');else{let offset=0;const chunks:Buffer[]=[];while(offset<t.length){const n=t.readUInt32BE(offset);offset+=4;chunks.push(t.subarray(offset,offset+n));offset+=n;}if(mutate==='opaque')chunks[6]!.fill(0);else chunks[2]![0]^=1;c.transcriptBase64=t.toString('base64');}}
 await expect(possessionChallenge(c,target,vectors.now,sha)).rejects.toThrow('pairing_release_challenge_invalid');
});
test('watch-only proof release validates every receipt binding and sends no old account or secrets',async()=>{
 const calls:any[]=[];await releaseByPossession(target,{now:()=>vectors.now,sha256:sha,proof,rpc:async(path,body)=>{calls.push({path,body});return{status:200,body:path.endsWith('challenge')?vectors.challenge:{sessionId:target.sessionId,challengeId:vectors.challenge.challengeId,deviceId:target.deviceId,installId:target.installId,targetUserId:target.userId,ownershipReleased:true}};}});
 expect(calls).toEqual([{path:'ownership/challenge',body:{deviceId:target.deviceId,installId:target.installId,targetUserId:target.userId}},{path:'ownership/release',body:{challengeId:vectors.challenge.challengeId,proofBase64:vectors.proofBase64}}]);expect(JSON.stringify(calls)).not.toMatch(/watchRefreshToken|releaseSecret|privateKey/);
});
test('cancel after native proof does not submit a release; mismatched receipt never counts as released',async()=>{
 let active=true,releases=0;const t={...target,check:()=>{if(!active)throw Error('cancelled');}};
 await expect(releaseByPossession(t,{now:()=>vectors.now,sha256:sha,proof:async a=>{const value=await proof(a);active=false;return value;},rpc:async path=>{if(path.endsWith('release'))releases++;return{status:200,body:vectors.challenge};}})).rejects.toThrow('cancelled');expect(releases).toBe(0);
 await expect(releaseByPossession(target,{now:()=>vectors.now,sha256:sha,proof,rpc:async path=>({status:200,body:path.endsWith('challenge')?vectors.challenge:{ownershipReleased:true,deviceId:'other'}})})).rejects.toThrow('pairing_release_unverified');
});
const account:WatchAccountState={userId:'11111111-1111-4111-8111-111111111111',phoneMasked:'1***',installId:target.installId,watchDeviceToken:'old',watchRefreshToken:'refresh',tokenExpiresAtMillis:9e15,refreshTokenExpiresAtMillis:9e15,backendBaseUrl:'https://sly-data-plane.watchrss.cn',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},updatedAtMillis:0};
async function fixture(){const values=new Map<string,string>(),events:string[]=[],store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);},clearCloudScope:async()=>{events.push('scope-clear');}});await store.save(account);return{values,events,store};}
for(const mode of ['normal','missing','expired'] as const)test('replacement '+mode+' releases before clearing and assigning the new owner',async()=>{
 const f=await fixture();if(mode==='missing')await f.store.expire(account);
 const result=await replacePairingAccount(target,{read:()=>f.store.read(),releaseStored:(old,run)=>f.store.releaseOwnershipForPairing(old,run),normal:async()=>{f.events.push('normal');if(mode==='expired')throw new WatchLoginExpiredError();},possession:async()=>{f.events.push('proof');},clearAndSetOwner:t=>f.store.resolveLibraryOwner({userId:t.userId,backendBaseUrl:account.backendBaseUrl},'clear',async()=>{f.events.push('clear');}),progress:p=>f.events.push(p)});
 expect(result).toEqual({released:true,cleared:true});expect(await f.store.read()).toBeNull();expect(f.values.get('watchrss.library.owner')).toBe(JSON.stringify([account.backendBaseUrl,target.userId]));expect(f.events.indexOf('clear')).toBeGreaterThan(f.events.lastIndexOf(mode==='normal'?'normal':'proof'));
});
test('network failure after refresh retains the rotated pair for retry, does not wipe, and never claims release',async()=>{
 const f=await fixture();await expect(replacePairingAccount(target,{read:()=>f.store.read(),releaseStored:(old,run)=>f.store.releaseOwnershipForPairing(old,run),normal:async(old,save)=>{await save({...old,watchRefreshToken:'rotated'});throw Object.assign(Error('offline'),{status:503});},possession:async()=>{throw Error('must not use proof to hide network failure');},clearAndSetOwner:async()=>{throw Error('must not clear');},progress:()=>{}})).rejects.toMatchObject({code:'pairing_release_failed',released:false,cleared:false});expect((await f.store.read())?.watchRefreshToken).toBe('rotated');expect(f.events).toEqual([]);
});
test('device_revoked cannot be bypassed by proof or wipe',async()=>{
 const f=await fixture();await expect(replacePairingAccount(target,{read:()=>f.store.read(),releaseStored:(old,run)=>f.store.releaseOwnershipForPairing(old,run),normal:async()=>{throw Object.assign(Error('banned'),{code:'device_revoked',status:403});},possession:async()=>{throw Error('must not proof');},clearAndSetOwner:async()=>{throw Error('must not clear');},progress:()=>{}})).rejects.toMatchObject({code:'pairing_device_revoked',released:false,retryable:false});expect(await f.store.read()).not.toBeNull();
});

test('uncertain release delivery retains the original proof/challenge; retry reads the same receipt only',async()=>{
 const state={},releases:any[]=[],calls:string[]=[];let fail=true,proofs=0;
 const ports={now:()=>vectors.now,sha256:sha,proof:async(a:any)=>{proofs++;return proof(a);},rpc:async(path:string,body:any)=>{calls.push(path);if(path.endsWith('challenge'))return{status:200,body:vectors.challenge};releases.push(body);if(fail){fail=false;return{status:0,body:{code:'pairing_release_network'}};}return{status:200,body:{sessionId:target.sessionId,challengeId:vectors.challenge.challengeId,deviceId:target.deviceId,installId:target.installId,targetUserId:target.userId,ownershipReleased:true}};}};
 await expect(releaseByPossession(target,ports,state)).rejects.toThrow('pairing_release_network');await releaseByPossession(target,ports,state);await releaseByPossession(target,ports,state);
 expect(calls).toEqual(['ownership/challenge','ownership/release','ownership/release']);expect(releases[0]).toEqual(releases[1]);expect(proofs).toBe(1);
});

test('pairing save cancelled while waiting for the account mutation lease never writes credentials',async()=>{
 let release!:(value:void)=>void,entered!:(value:void)=>void;const enteredPromise=new Promise<void>(yes=>{entered=yes;}),gate=new Promise<void>(yes=>{release=yes;}),values=new Map<string,string>();let active=true,accountWrites=0;
 const store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{if(k==='state_json')accountWrites++;values.set(k,v);},remove:k=>{values.delete(k);}});
 const holding=store.releaseOwnershipForPairing(null,async()=>{entered();await gate;});await enteredPromise;
 const queued=store.save(account,undefined,()=>{if(!active)throw Error('pairing_cancelled');});active=false;release();await holding;await expect(queued).rejects.toThrow('pairing_cancelled');expect(accountWrites).toBe(0);expect(await store.read()).toBeNull();
});
