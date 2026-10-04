import {test,expect} from 'bun:test';
import {createHash,createHmac} from 'node:crypto';
import fixture from '../fixtures/ip-protocol-native.json';
import {parseIpDescriptor,ipDescriptorPayload,verifyIpDescriptor,buildIpHello,parseIpHelloAck,verifyIpHelloAck,ipHmac,type IpCrypto} from '../../src/sync/ip-protocol.ts';
const sha=async(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
const crypto:IpCrypto={nonce:async()=>'nonce',hmac:async(secret,payload)=>{if(!/^[A-Za-z0-9_-]*={0,2}$/.test(secret)||secret.length%4===1)throw new Error('bad key');return Buffer.from(await ipHmac(new Uint8Array(Buffer.from(secret,'base64url')),payload,sha)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');}};
for(const [index,row] of fixture.cases.entries())test('native IP descriptor and handshake '+index,async()=>{
 const d=parseIpDescriptor(row.input);expect(ipDescriptorPayload(d)).toBe(row.canonical);
 if('error' in row){await expect(crypto.hmac(d.challengeSecret,row.canonical)).rejects.toThrow();return;}
 d.hmac=row.signature!;expect(await verifyIpDescriptor(d,crypto,1000)).toBe(row.valid!);expect(await verifyIpDescriptor({...d,hmac:d.hmac+'x'},crypto,1000)).toBe(false);
 expect(await buildIpHello(d,'watch😀','nonce',index%2?'resume':null,index,crypto)).toEqual(row.hello!);expect(await verifyIpHelloAck(d,parseIpHelloAck(row.ack!),crypto)).toBe(row.ackValid!);
 expect(await verifyIpHelloAck(d,{...parseIpHelloAck(row.ack!),serverDeviceId:'other'},crypto)).toBe(false);
});
test('HMAC matches independent crypto for long and short binary keys and Unicode',async()=>{
 for(const length of [1,16,64,65,129]){const key=Uint8Array.from({length},(_,i)=>(i*71)&255),text='手机😀|challenge\u0000';expect(Buffer.from(await ipHmac(key,text,sha)).toString('hex')).toBe(createHmac('sha256',key).update(text).digest('hex'));}
});
