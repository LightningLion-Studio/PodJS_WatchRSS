import {sha256Hex} from '@podjs/framework/crypto';
import {utf8Encode} from '../cloud/types';
import {encodeBase64} from '@podjs/framework/bytes';
export interface AssetConflictFiles {
 hash(path:string):Promise<{sha256:string}>;
 write(path:string,dataBase64:string):Promise<unknown>;
 commit(path:string,target:string,size:number,sha256:string,expectedTargetSha256?:string|null):Promise<unknown>;
}
/** Preserve incoming bytes under their hash, separately from the winning local
 * original. A failed conflict write never permits replacing that original. */
export async function retainAssetConflict(files:AssetConflictFiles,part:string,key:string,sha256:string,size:number,expectedTargetSha256:string|null){
 const path='notes/asset-conflicts/'+sha256Hex(utf8Encode(key))+'-'+sha256+'.bin';
 try{await files.commit(part,path,size,sha256,null);}catch(error){if(!String(error).includes('file_target_changed')||(await files.hash(path)).sha256!==sha256)throw error;}
 const marker={version:1,kind:'asset',storageKey:key,incomingSha256:sha256,expectedTargetSha256,retainedPath:path};
 await files.write(path+'.json',encodeBase64(utf8Encode(JSON.stringify(marker))));
}
