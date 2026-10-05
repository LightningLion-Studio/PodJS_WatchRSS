import {createHash,randomBytes,hkdfSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {SnapshotCrypto} from '../../src/cloud/codec';
export const enabled={require(){}};
export const crypto:SnapshotCrypto={random:async n=>new Uint8Array(randomBytes(n)),sha256:async b=>createHash('sha256').update(b).digest('hex'),hkdf:async(k,s,i)=>new Uint8Array(hkdfSync('sha256',k,s,i,32)),encrypt:async(k,a,p)=>{const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(p),c.final(),c.getAuthTag()]))};},decrypt:async(k,a,n,b)=>{const c=createDecipheriv('aes-256-gcm',k,n);c.setAAD(a);c.setAuthTag(b.slice(-16));return new Uint8Array(Buffer.concat([c.update(b.slice(0,-16)),c.final()]));},gzip:async b=>new Uint8Array(gzipSync(b)),gunzip:async(b,max)=>{const out=new Uint8Array(gunzipSync(b,{maxOutputLength:Math.max(1,max)}));if(out.length>max)throw Error('inflate limit');return out;}};
export const key=new Uint8Array(32).fill(41);
