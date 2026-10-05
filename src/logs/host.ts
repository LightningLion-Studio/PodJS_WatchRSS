import {fileChunks,hostOperation,rsaOaepSha256,webSockets} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {kv} from '@podjs/framework/watch';
import {SyncDiagnosticLog} from '../sync/diagnostic-log.ts';
import {createTtsTransport} from '../tts/transport.ts';
import type {LogCrypto} from './encryption.ts';
import {createInstantLogBackend} from './instant.ts';
import {diagnosticLogSource,type LogUploadOptions} from './upload.ts';

export const hostLogCrypto:LogCrypto={
  async random(bytes){return base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes}).result).bytesBase64);},
  async gzip(bytes){
    if(bytes.length<=64*1024)return base64ToBytes((await fileChunks.gzipBytes(bytesToBase64(bytes))).dataBase64);
    const input=await fileChunks.createTemp('log-upload');let output:string|undefined;
    try {
      for(let offset=0;offset<bytes.length;offset+=65536){const part=bytes.subarray(offset,offset+65536);const written=await fileChunks.append(input.path,bytesToBase64(part),offset);if(written.size!==offset+part.length)throw Error('日志压缩输入不完整');}
      const result=await fileChunks.gzip(input.path,4*1024*1024);output=result.path;
      if(!Number.isSafeInteger(result.size)||result.size<0||result.size>4*1024*1024)throw Error('日志压缩大小无效');
      const zipped=new Uint8Array(result.size);
      for(let offset=0;offset<zipped.length;){const chunk=await fileChunks.read(output,offset,Math.min(65536,zipped.length-offset));const part=base64ToBytes(chunk.dataBase64);if(chunk.offset!==offset||chunk.size!==zipped.length||!part.length||part.length>Math.min(65536,zipped.length-offset))throw Error('日志压缩读取不完整');zipped.set(part,offset);offset+=part.length;}
      return zipped;
    } finally {if(output)await fileChunks.remove(output).catch(()=>{});await fileChunks.remove(input.path).catch(()=>{});}
  },
  async aesGcm(key,plaintext){
    if(plaintext.length>256*1024)throw Error('压缩日志超过当前宿主加密上限（256 KiB）');
    const result=await hostOperation<{nonceBase64:string;ciphertextBase64:string}>('crypto.aesGcmEncrypt',{keyBase64:bytesToBase64(key),dataBase64:bytesToBase64(plaintext),aadBase64:''}).result;
    return {nonce:base64ToBytes(result.nonceBase64),ciphertext:base64ToBytes(result.ciphertextBase64)};
  },
  async rsaOaepSha256(pem,key){return base64ToBytes((await rsaOaepSha256(pem,bytesToBase64(key)).result).ciphertextBase64);},
};
async function uuid(){const bytes=await hostLogCrypto.random(16);if(bytes.length!==16)throw Error('日志 ID 随机源无效');bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
/** Creating options does no I/O. Only an explicitly mounted screen starts upload. */
export function createHostLogUploadOptions():LogUploadOptions {
  return {source:diagnosticLogSource(new SyncDiagnosticLog(kv)),crypto:hostLogCrypto,uuid,
    backend:createInstantLogBackend({http:createTtsTransport(),uuid,async connect(url){
      const {id}=await webSockets.connect(url,{timeoutMs:10000}).result;
      return {async send(message){const result=await webSockets.writeText(id,JSON.stringify(message)).result;if(!result.sent)throw Error('日志服务发送失败');},async read(){return JSON.parse((await webSockets.readText(id,15000).result).text);},close:()=>webSockets.close(id)};
    }})};
}
