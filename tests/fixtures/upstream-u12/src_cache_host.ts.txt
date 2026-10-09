import {fileChunks,hostOperation,base64ToBytes,bytesToBase64,stringToUtf8} from '@podjs/framework/services';
import {ManagedCache} from './managed.ts';
export const managedCache=new ManagedCache({
 list:fileChunks.list,stat:fileChunks.stat,remove:fileChunks.remove,touch:fileChunks.touch,
 async validate(path){const decoded=await hostOperation<{path:string}>('image.decode',{path,maxDimension:1}).result;await fileChunks.remove(decoded.path);},
 async digest(value){const result=await hostOperation<{digestBase64:string}>('crypto.hash',{algorithm:'SHA-256',dataBase64:bytesToBase64(stringToUtf8(value))}).result;return Array.from(base64ToBytes(result.digestBase64),b=>b.toString(16).padStart(2,'0')).join('');},
 download:(url,path,headers)=>hostOperation('http.download',{url,path,headers,maxBytes:8*1024*1024}),
});
