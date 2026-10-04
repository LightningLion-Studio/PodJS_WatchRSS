import {base64ToBytes,bytesToBase64,stringToUtf8,utf8ToString} from '@podjs/framework/bytes';
import {hostOperation} from '@podjs/framework/services';

export const CONFIG_PAIRING_PROTOCOL='watchrss-config-pairing-v1';
export const CONFIG_PAIRING_NONCE_HEADER='X-WatchRSS-Pairing-Nonce';
export const CONFIG_PAIRING_AUTH_HEADER='X-WatchRSS-Pairing-Auth';
const ENCRYPTION_CONTEXT='watchrss-config-encryption-v1';
const MAX_REQUESTS=512;
const url64=(bytes:Uint8Array)=>bytesToBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function fromUrl64(value:string):Uint8Array {
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid pairing base64');
 const bytes=base64ToBytes(value.replace(/-/g,'+').replace(/_/g,'/'));
 if(url64(bytes)!==value)throw new Error('Invalid pairing base64');
 return bytes;
}
function concat(...parts:Uint8Array[]):Uint8Array {const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){result.set(part,at);at+=part.length;}return result;}
function same(a:string,b:string){if(a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}

export interface ConfigCrypto {
 random(bytes:number):Promise<Uint8Array>;
 hash(input:Uint8Array):Promise<Uint8Array>;
 hmac(key:Uint8Array,input:Uint8Array):Promise<Uint8Array>;
 encrypt(key:Uint8Array,aad:Uint8Array,input:Uint8Array):Promise<{nonce:Uint8Array;ciphertext:Uint8Array}>;
 decrypt(key:Uint8Array,aad:Uint8Array,nonce:Uint8Array,ciphertext:Uint8Array):Promise<Uint8Array>;
}
export const hostConfigCrypto:ConfigCrypto={
 async random(bytes){return base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes}).result).bytesBase64);},
 async hash(input){return base64ToBytes((await hostOperation<{digestBase64:string}>('crypto.hash',{dataBase64:bytesToBase64(input)}).result).digestBase64);},
 async hmac(key,input){return base64ToBytes((await hostOperation<{digestBase64:string}>('crypto.hmacSha256',{keyBase64:bytesToBase64(key),dataBase64:bytesToBase64(input)}).result).digestBase64);},
 async encrypt(key,aad,input){const result=await hostOperation<{nonceBase64:string;ciphertextBase64:string}>('crypto.aesGcmEncrypt',{keyBase64:bytesToBase64(key),aadBase64:bytesToBase64(aad),dataBase64:bytesToBase64(input)}).result;return {nonce:base64ToBytes(result.nonceBase64),ciphertext:base64ToBytes(result.ciphertextBase64)};},
 async decrypt(key,aad,nonce,ciphertext){const result=await hostOperation<{dataBase64:string}>('crypto.aesGcmDecrypt',{keyBase64:bytesToBase64(key),aadBase64:bytesToBase64(aad),nonceBase64:bytesToBase64(nonce),ciphertextBase64:bytesToBase64(ciphertext)}).result;return base64ToBytes(result.dataBase64);}
};

/** The token is present only in the QR URL fragment, never in HTTP requests. */
export class ConfigPairingSession {
 readonly pairingToken:string;
 private readonly token:Uint8Array;
 private readonly nonces=new Set<string>();
 private active=true;
 private encryptionKey?:Promise<Uint8Array>;
 private constructor(token:Uint8Array,private readonly crypto:ConfigCrypto){this.token=token;this.pairingToken=url64(token);}
 static async create(crypto:ConfigCrypto=hostConfigCrypto){const token=await crypto.random(32);if(token.length!==32)throw new Error('Invalid pairing token');return new ConfigPairingSession(token,crypto);}
 static fromToken(token:string,crypto:ConfigCrypto){const decoded=fromUrl64(token);if(decoded.length!==32)throw new Error('Invalid pairing token');return new ConfigPairingSession(decoded,crypto);}
 qrContent(address:string,port:number){return `http://${address}:${port}/#watchrss_pair=${this.pairingToken}&protocol=${CONFIG_PAIRING_PROTOCOL}`;}
 async requestProof(method:string,uri:string,nonce:string,body:string):Promise<string>{
  const digest=url64(await this.crypto.hash(stringToUtf8(body)));
  const canonical=`${method.toUpperCase()}\n${uri}\n${nonce}\n${digest}`;
  return url64(await this.crypto.hmac(this.token,stringToUtf8(canonical)));
 }
 async authenticate(method:string,uri:string,nonce:string|undefined,body:string,proof:string|undefined):Promise<boolean>{
  if(!this.active||!nonce||!proof||this.nonces.size>=MAX_REQUESTS||this.nonces.has(nonce))return false;
  try{if(fromUrl64(nonce).length!==16)return false;}catch{return false;}
  if(!same(await this.requestProof(method,uri,nonce,body),proof))return false;
  this.nonces.add(nonce);return true;
 }
 private key(){return this.encryptionKey??=this.crypto.hash(concat(stringToUtf8(ENCRYPTION_CONTEXT),new Uint8Array([0]),this.token));}
 private aad(method:string,uri:string){return stringToUtf8(`${method.toUpperCase()}\n${uri}`);}
 async encryptResponse(method:string,uri:string,plaintext:string){if(!this.active)throw new Error('Pairing session inactive');const {nonce,ciphertext}=await this.crypto.encrypt(await this.key(),this.aad(method,uri),stringToUtf8(plaintext));return JSON.stringify({protocol:CONFIG_PAIRING_PROTOCOL,iv:url64(nonce),ciphertext:url64(ciphertext)});}
 async decryptRequest(method:string,uri:string,envelope:string){if(!this.active)throw new Error('Pairing session inactive');const value=JSON.parse(envelope) as {protocol?:string;iv?:string;ciphertext?:string};if(value.protocol!==CONFIG_PAIRING_PROTOCOL||typeof value.iv!=='string'||typeof value.ciphertext!=='string')throw new Error('Invalid pairing envelope');const iv=fromUrl64(value.iv),ciphertext=fromUrl64(value.ciphertext);if(iv.length!==12||ciphertext.length<16)throw new Error('Invalid pairing envelope');return utf8ToString(await this.crypto.decrypt(await this.key(),this.aad(method,uri),iv,ciphertext));}
 claimWrite(){if(!this.active)return false;this.invalidate();return true;}
 invalidate(){this.active=false;this.nonces.clear();}
}
