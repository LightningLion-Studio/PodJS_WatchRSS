import {secureStorage,hostOperation,bytesToBase64,base64ToBytes} from '@podjs/framework/services';
import {utf8Encode} from '../cloud/types.ts';
import {biliClient,douyinClient} from '../media-services.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {appLogger} from '../logs/app-logger.ts';
import {debugGate} from './host.ts';
import {CredentialsBackup} from './credentials.ts';
export const credentialsBackup=new CredentialsBackup(debugGate,{
 get:secureStorage.get,
 async commit(values){
  let committed=false;
  const commit=async()=>{await secureStorage.update(values);committed=true;};
  try{
   if(values['douyin.cookie']===null)await douyinClient.clearCookie(commit);
   else await douyinClient.applyCookie(values['douyin.cookie'],commit);
  }finally{if(committed){biliClient.invalidateSession();summaryAccountStore.invalidate();}}
 },
 async fingerprint(value){const result=await hostOperation<{digestBase64:string}>('crypto.hash',{algorithm:'SHA-256',dataBase64:bytesToBase64(utf8Encode(value))}).result;return Array.from(base64ToBytes(result.digestBase64),b=>b.toString(16).padStart(2,'0')).join('');},
 log:line=>appLogger.d('CredentialsBackup',line),
});
