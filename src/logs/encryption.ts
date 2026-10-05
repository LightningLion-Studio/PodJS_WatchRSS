import {bytesToBase64, stringToUtf8} from '@podjs/framework/bytes';
import {LOG_PUBLIC_KEY} from './constants.ts';

export interface LogCrypto {
  gzip(bytes:Uint8Array):Promise<Uint8Array>;
  random(size:number):Promise<Uint8Array>;
  aesGcm(key:Uint8Array, plaintext:Uint8Array):Promise<{nonce:Uint8Array;ciphertext:Uint8Array}>;
  rsaOaepSha256(publicKey:string, key:Uint8Array):Promise<Uint8Array>;
}
/** Native Jw/Yw: gzip UTF-8, AES-256-GCM (128-bit tag, no AAD),
 * [IV length:1][IV:12][ciphertext+tag], separately base64 RSA-OAEP-SHA256 key. */
export async function encryptLog(text:string, crypto:LogCrypto) {
  const compressed=await crypto.gzip(stringToUtf8(text));
  const key=await crypto.random(32);
  if(key.length!==32)throw Error('日志密钥长度无效');
  try {
    const {nonce,ciphertext}=await crypto.aesGcm(key,compressed);
    if(nonce.length!==12||ciphertext.length!==compressed.length+16)throw Error('日志加密格式无效');
    const wrapped=await crypto.rsaOaepSha256(LOG_PUBLIC_KEY,key);
    if(wrapped.length!==256)throw Error('日志密钥封装无效');
    const bytes=new Uint8Array(1+nonce.length+ciphertext.length);
    bytes[0]=nonce.length;bytes.set(nonce,1);bytes.set(ciphertext,1+nonce.length);
    return {bytes,encryptedAesKey:bytesToBase64(wrapped)};
  } finally {key.fill(0);}
}
