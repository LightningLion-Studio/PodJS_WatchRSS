import {sha256Hex,unhex,lengthPrefixFields} from '@podjs/framework/crypto';
import {bytes,canonical,jsonBytes,parseCanonicalJson,opaqueContentId,type Scope} from './protocol';
import {b64,unb64,header,sameScope} from './wire';
export interface EnvelopeCrypto {
 random(count:number):Promise<Uint8Array>;hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
 encrypt(key:Uint8Array,nonce:Uint8Array,input:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;
 decrypt(key:Uint8Array,nonce:Uint8Array,input:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;
 gunzip(input:Uint8Array,plainBytes:number):Promise<Uint8Array>;
}
export type ContentKeyResolver=(version:number)=>Promise<Uint8Array>;
export interface ObjectKeys {id:Uint8Array;content:Uint8Array;version:number;readContentKey?:ContentKeyResolver}
export const objectOid=(type:string,input:Uint8Array)=>type+':sha256:'+sha256Hex(input);
/** Randomness is obtained before computing final AAD. No fixture nonce option. */
export async function sealV2(c:EnvelopeCrypto,idKey:Uint8Array,contentKey:Uint8Array,scope:Scope,type:string,keyVersion:number,plain:Uint8Array){
 if(idKey.length!==32||contentKey.length!==32)throw Error('invalid_schema');
 const salt=await c.random(32),nonce=await c.random(12);const h={domain:'wrss.sync.v2/sealed',version:2,scope,keyVersion,type,opaqueContentId:opaqueContentId(idKey,scope,type,plain),encoding:'identity',plainBytes:plain.length,encodedBytes:plain.length,salt:b64(salt),nonce:b64(nonce)};
 header(h,plain.length);const aad=jsonBytes(h);if(aad.length>4096)throw Error('object_too_large');
 const key=await c.hkdf(contentKey,salt,lengthPrefixFields([bytes('wrss.sync.v2/aead'),unhex(sha256Hex(aad))]));
 try{const ciphertext=await c.encrypt(key,nonce,plain,aad);if(ciphertext.length!==plain.length+16)throw Error('invalid_encoding');const sealed=new Uint8Array(8+aad.length+ciphertext.length);sealed.set(bytes('WRS2'));new DataView(sealed.buffer).setUint32(4,aad.length,false);sealed.set(aad,8);sealed.set(ciphertext,8+aad.length);return {oid:objectOid(type,sealed),bytes:sealed,header:h};}finally{key.fill(0);}
}
export async function openV2(c:EnvelopeCrypto,idKey:Uint8Array,contentKey:Uint8Array|ContentKeyResolver,scope:Scope,expectedOid:string,input:Uint8Array){
 if(input.length<24||input.length>266264||input.subarray(0,4).some((b,i)=>b!==[87,82,83,50][i]))throw Error('invalid_encoding');
 const n=new DataView(input.buffer,input.byteOffset,input.byteLength).getUint32(4,false);if(n>4096||8+n+16>input.length)throw Error('invalid_encoding');const aad=input.subarray(8,8+n),h=parseCanonicalJson(aad);header(h,input.length-8-n-16);sameScope(h.scope,scope);if(objectOid(h.type,input)!==expectedOid)throw Error('hash_mismatch');const resolved=typeof contentKey==='function'?await contentKey(h.keyVersion):contentKey;if(!resolved||resolved.length!==32)throw Error(typeof contentKey==='function'?'key_unavailable':'invalid_schema');if(idKey.length!==32)throw Error('invalid_schema');
 const key=await c.hkdf(resolved,unb64(h.salt,32),lengthPrefixFields([bytes('wrss.sync.v2/aead'),unhex(sha256Hex(aad))]));let encoded:Uint8Array;
 try{encoded=await c.decrypt(key,unb64(h.nonce,12),input.subarray(8+n),aad);}catch{throw Error('aead_invalid');}finally{key.fill(0);}
 const plain=h.encoding==='gzip'?await c.gunzip(encoded,h.plainBytes):encoded;
 if(plain.length!==h.plainBytes||opaqueContentId(idKey,scope,h.type,plain)!==h.opaqueContentId)throw Error('fingerprint_mismatch');
 return {header:h,plain,value:h.type==='blob'?null:parseCanonicalJson(plain)};
}
