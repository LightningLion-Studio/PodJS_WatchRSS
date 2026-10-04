import {expect,test} from 'bun:test';
import {createCipheriv,createDecipheriv,createHash,createHmac} from 'node:crypto';
import {ConfigPairingSession,CONFIG_PAIRING_PROTOCOL,type ConfigCrypto} from '../src/tts/config-pairing.ts';
const bytes=(value:string)=>new TextEncoder().encode(value);
const url=(value:Uint8Array)=>Buffer.from(value).toString('base64url');
let counter=0;
const crypto:ConfigCrypto={
 async random(count){const result=new Uint8Array(count);for(let i=0;i<count;i++)result[i]=i;return result;},
 async hash(input){return new Uint8Array(createHash('sha256').update(input).digest());},
 async hmac(key,input){return new Uint8Array(createHmac('sha256',key).update(input).digest());},
 async encrypt(key,aad,input){const nonce=new Uint8Array(12).fill(++counter);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(input),cipher.final(),cipher.getAuthTag()]);return {nonce,ciphertext:new Uint8Array(ciphertext)};},
 async decrypt(key,aad,nonce,ciphertext){const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad);decipher.setAuthTag(ciphertext.slice(-16));return new Uint8Array(Buffer.concat([decipher.update(ciphertext.slice(0,-16)),decipher.final()]));}
};
test('TTS config pairing matches native proof, envelope, replay and single write',async()=>{
 const session=await ConfigPairingSession.create(crypto),token=new Uint8Array(32).map((_,i)=>i),nonce=url(new Uint8Array(16).fill(7));
 expect(session.pairingToken).toBe(url(token));
 expect(session.qrContent('192.0.2.4',8765)).toBe(`http://192.0.2.4:8765/#watchrss_pair=${url(token)}&protocol=${CONFIG_PAIRING_PROTOCOL}`);
 const body='{"protocol":"watchrss-config-pairing-v1","iv":"a","ciphertext":"b"}';
 const digest=url(new Uint8Array(createHash('sha256').update(body).digest()));
 const canonical=`POST\n/setTtsConfig\n${nonce}\n${digest}`;
 const expected=url(new Uint8Array(createHmac('sha256',token).update(canonical).digest()));
 expect(await session.requestProof('post','/setTtsConfig',nonce,body)).toBe(expected);
 expect(await session.authenticate('POST','/setTtsConfig',nonce,body,expected)).toBe(true);
 expect(await session.authenticate('POST','/setTtsConfig',nonce,body,expected)).toBe(false);
 expect(await session.authenticate('POST','/setTtsConfig',url(new Uint8Array(15)),body,expected)).toBe(false);
 const key=new Uint8Array(createHash('sha256').update(bytes('watchrss-config-encryption-v1')).update(new Uint8Array([0])).update(token).digest());
 const plaintext='{"engine":"minimax","apiKey":"secret"}',aad=bytes('POST\n/setTtsConfig');
 const incoming=await crypto.encrypt(key,aad,bytes(plaintext));
 const envelope=JSON.stringify({protocol:CONFIG_PAIRING_PROTOCOL,iv:url(incoming.nonce),ciphertext:url(incoming.ciphertext)});
 expect(await session.decryptRequest('POST','/setTtsConfig',envelope)).toBe(plaintext);
 await expect(session.decryptRequest('GET','/getTtsConfig',envelope)).rejects.toThrow();
 const response=JSON.parse(await session.encryptResponse('GET','/getTtsConfig','{"success":true}'));
 expect(response.protocol).toBe(CONFIG_PAIRING_PROTOCOL);
 expect(new TextDecoder().decode(await crypto.decrypt(key,bytes('GET\n/getTtsConfig'),Buffer.from(response.iv,'base64url'),Buffer.from(response.ciphertext,'base64url')))).toBe('{"success":true}');
 expect(session.claimWrite()).toBe(true);expect(session.claimWrite()).toBe(false);
 await expect(session.decryptRequest('POST','/setTtsConfig',envelope)).rejects.toThrow();
});
