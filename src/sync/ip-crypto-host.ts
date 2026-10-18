import {sha256Bytes} from '@podjs/framework/bytes';
import {hostOperation,base64ToBytes,bytesToBase64} from '@podjs/framework/services';
import {ipHmac,type IpCrypto} from './ip-protocol.ts';
const url=(bytes:Uint8Array)=>bytesToBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_');
function decode(value:string){if(!/^[A-Za-z0-9_-]*={0,2}$/.test(value)||value.length%4===1||(value.includes('=')&&value.length%4!==0))throw new Error('Invalid URL-safe key');return base64ToBytes(value.replace(/-/g,'+').replace(/_/g,'/'));}
export const hostIpCrypto:IpCrypto={
 hmac:async(secret,payload)=>url(await ipHmac(decode(secret),payload,async bytes=>sha256Bytes(bytes)??base64ToBytes((await hostOperation<{digestBase64:string}>('crypto.hash',{dataBase64:bytesToBase64(bytes),algorithm:'SHA-256'}).result).digestBase64))),
 nonce:async()=>url(base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64)),
};
