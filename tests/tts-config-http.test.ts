import {expect,test} from 'bun:test';
import {createCipheriv,createHash,createHmac} from 'node:crypto';
import {ConfigPairingSession,CONFIG_PAIRING_PROTOCOL} from '../src/tts/config-pairing.ts';
import {routeTtsConfigHttp} from '../src/tts/config-http.ts';
import {TtsConfigStore} from '../src/tts/config-store.ts';
const url=(v:Uint8Array)=>Buffer.from(v).toString('base64url');
const bytes=(v:string)=>new TextEncoder().encode(v);
test('authenticated encrypted TTS write persists once and read masks the key',async()=>{
 const token=new Uint8Array(32).fill(11),session=ConfigPairingSession.fromToken(url(token),{
  random:async n=>new Uint8Array(n),hash:async v=>new Uint8Array(createHash('sha256').update(v).digest()),
  hmac:async(k,v)=>new Uint8Array(createHmac('sha256',k).update(v).digest()),
  encrypt:async(k,a,v)=>{const nonce=new Uint8Array(12).fill(3),c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce,ciphertext:new Uint8Array(Buffer.concat([c.update(v),c.final(),c.getAuthTag()]))};},
  decrypt:async()=>{throw Error('unused')}
 });
 const plain=new Map<string,unknown>(),secrets=new Map<string,string>();
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);}});
 const auth=async(method:string,uri:string,body:string,n:number)=>{const nonce=url(new Uint8Array(16).fill(n));return {'x-watchrss-pairing-nonce':nonce,'x-watchrss-pairing-auth':await session.requestProof(method,uri,nonce,body)};};
 const get=await routeTtsConfigHttp({method:'GET',target:'/getTtsConfig',headers:await auth('GET','/getTtsConfig','',1),body:''},session,store);
 expect(get.status).toBe(200);expect(get.body).not.toContain('apiKey');
 const bad=await routeTtsConfigHttp({method:'POST',target:'/setTtsConfig',headers:{},body:'{}'},session,store);expect(bad.status).toBe(401);
 const key=new Uint8Array(createHash('sha256').update(bytes('watchrss-config-encryption-v1')).update(new Uint8Array([0])).update(token).digest());
 const iv=new Uint8Array(12).fill(4),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(bytes('POST\n/setTtsConfig'));
 const payload=JSON.stringify({engine:'minimax',model:'speech-2.8-hd',voiceId:'male-qn-qingse',speed:1,baseUrl:'https://api.minimaxi.com',apiKey:'secret-1234'});
 const body=JSON.stringify({protocol:CONFIG_PAIRING_PROTOCOL,iv:url(iv),ciphertext:url(new Uint8Array(Buffer.concat([cipher.update(bytes(payload)),cipher.final(),cipher.getAuthTag()]))) });
 // Use a decrypt implementation with the same token; proof and ciphertext are independent.
 const {createDecipheriv}=await import('node:crypto');
 const working=ConfigPairingSession.fromToken(url(token),{
  random:async n=>new Uint8Array(n),hash:async v=>new Uint8Array(createHash('sha256').update(v).digest()),hmac:async(k,v)=>new Uint8Array(createHmac('sha256',k).update(v).digest()),
  encrypt:async()=>{throw Error('unused')},decrypt:async(k,a,nonce,data)=>{const d=createDecipheriv('aes-256-gcm',k,nonce);d.setAAD(a);d.setAuthTag(data.slice(-16));return new Uint8Array(Buffer.concat([d.update(data.slice(0,-16)),d.final()]));}
 });
 const invalidCipher=createCipheriv('aes-256-gcm',key,new Uint8Array(12).fill(5));invalidCipher.setAAD(bytes('POST\n/setTtsConfig'));
 const invalidPayload=JSON.stringify({...JSON.parse(payload),apiKey:''});
 const invalidBody=JSON.stringify({protocol:CONFIG_PAIRING_PROTOCOL,iv:url(new Uint8Array(12).fill(5)),ciphertext:url(new Uint8Array(Buffer.concat([invalidCipher.update(bytes(invalidPayload)),invalidCipher.final(),invalidCipher.getAuthTag()]))) });
 const invalidHeaders=await auth('POST','/setTtsConfig',invalidBody,3);
 expect((await routeTtsConfigHttp({method:'POST',target:'/setTtsConfig',headers:invalidHeaders,body:invalidBody},working,store)).status).toBe(400);
 const headers=await auth('POST','/setTtsConfig',body,2);
 expect((await routeTtsConfigHttp({method:'POST',target:'/setTtsConfig',headers,body},working,store)).status).toBe(200);
 expect(JSON.stringify([...plain])).not.toContain('secret-1234');expect(await store.apiKey('minimax')).toBe('secret-1234');expect((await store.publicConfig()).apiKey).toBe('****1234');
 expect((await routeTtsConfigHttp({method:'POST',target:'/setTtsConfig',headers,body},working,store)).status).toBe(401);
});
