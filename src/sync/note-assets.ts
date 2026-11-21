import {noteAssetVersionPath,type NoteAssetFileIndex} from '../notes/asset-files';
import type {SqlCancellationCheck} from '../core/types';
import {digest} from '../sync-v2/protocol';
import type {LocalBodyClaims} from '../sync-v2/local-body-claims';
import type {NoteAssetIntake} from '../sync-v2/local-transfer-intake';
import {retainAssetConflict} from '../notes/asset-conflict';
import type {JsonObject} from './protocol.ts';
import {wireFields} from './article-batches.ts';
const CHUNK_BYTES=512*1024;
export interface NoteAssetInventory {storageKey:string;sha256:string;size:number}
export function parseNoteAssetInventory(value:unknown):NoteAssetInventory[]{
 if(!Array.isArray(value))throw Error('Invalid note asset inventory');return value.map(v=>{const r=v as NoteAssetInventory;if(!r||typeof r.storageKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(r.storageKey)||typeof r.sha256!=='string'||! /^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<0)throw Error('Invalid note asset inventory row');return {storageKey:r.storageKey,sha256:r.sha256,size:r.size};});
}
export interface NoteAssetFiles {
 stat(path:string):Promise<{file:boolean;size:number;modified?:number}>;
 readBytes?(path:string,offset:number,length:number):Promise<{bytes:Uint8Array;size:number}>;
 hash(path:string):Promise<{sha256:string;size:number}>;
 remove(path:string):Promise<void>;
 write(path:string,dataBase64:string):Promise<{size:number}>;
 append(path:string,dataBase64:string,offset:number):Promise<{size:number}>;
 commit(path:string,target:string,size:number,sha256:string,expectedTargetSha256?:string|null):Promise<unknown>;
}
interface StagedNoteAsset {
 path:string;
 sha256:string;
 count:number;
 intake:NoteAssetIntake;
 final?:{dataHash:string;rejected:boolean};
}
const result=(complete:boolean,alreadyPresent=false)=>({success:true,action:'syncNoteAsset',complete,alreadyPresent});
function required(request:JsonObject,key:string):string{if(request[key]===undefined||request[key]===null)throw new Error('缺少 '+key);return wireFields.string(request[key]);}
/** Ordered native note-asset protocol, retaining the old target until validated commit. */
export class NoteAssetReceiver {
 private queue:Promise<unknown>=Promise.resolve();
 private readonly staged=new WeakMap<object,Map<string,StagedNoteAsset>>();
 private serial=0;
 constructor(private readonly files:NoteAssetFiles,private readonly index?:NoteAssetFileIndex){}
 async inventory(input:unknown):Promise<NoteAssetInventory[]> {
  const rows=parseNoteAssetInventory(input),verified:NoteAssetInventory[]=[];
  for(const r of rows){try{const path=this.index?await this.index.path(r.storageKey):'notes/assets/'+r.storageKey;const stat=await this.files.stat(path);if(!stat.file||stat.size!==r.size)continue;const hash=await this.files.hash(path);const after=await this.files.stat(path);if(after.file&&after.size===r.size&&(stat.modified===undefined||after.modified===stat.modified)&&hash.size===r.size&&hash.sha256.toLowerCase()===r.sha256)verified.push(r);}catch{/* Missing or concurrently removed files are sent again. */}}
  return verified;
 }
 apply(request:JsonObject,intake?:NoteAssetIntake,check?:SqlCancellationCheck,session:object=this):Promise<JsonObject>{const job=this.queue.then(()=>this.receive(request,intake,check,session));this.queue=job.catch(()=>{});return job;}
 closeSession(session:object):Promise<void>{
  const job=this.queue.then(async()=>{
   const entries=this.staged.get(session);this.staged.delete(session);
   for(const asset of entries?.values()??[])await this.files.remove(asset.path).catch(()=>{});
  });
  this.queue=job.catch(()=>{});return job;
 }
 private async receive(request:JsonObject,intake:NoteAssetIntake|undefined,check:SqlCancellationCheck|undefined,session:object):Promise<JsonObject>{
  if(wireFields.optInt(request,'version')!==1)throw new Error('不支持的备忘录图片同步版本');
  const key=required(request,'storageKey');if(key.length<1||key.length>160||!/^[A-Za-z0-9]/.test(key)||/[^A-Za-z0-9._-]/.test(key))throw new Error('备忘录图片文件名无效');
  const sha256=required(request,'sha256').toLowerCase();if(sha256.length!==64||!/^[0-9a-f]{64}$/.test(sha256))throw new Error('备忘录图片校验值无效');
  const index=wireFields.optInt(request,'chunkIndex',-1),count=wireFields.optInt(request,'chunkCount',-1);
  if(count<=0||index<0||index>=count)throw new Error('备忘录图片分块序号无效');
  check?.();
  const target=this.index?await this.index.path(key):'notes/assets/'+key,offset=index*CHUNK_BYTES,complete=index===count-1;
  let part='notes/assets/.'+key+'.part',data:string|undefined;
  let state:StagedNoteAsset|undefined,replay=false;
  const readData=()=>{
   const value=required(request,'data');
   if(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.exec(value)?.[0]!==value)throw Error('invalid base64 chunk data');
   return value;
  };
  if(intake?.capture){
   let entries=this.staged.get(session);
   if(!entries){entries=new Map();this.staged.set(session,entries);}
   state=entries.get(key);
   if(complete&&state?.sha256===sha256&&state.count===count&&state.final){
    data=readData();replay=digest(data)===state.final.dataHash;
    if(replay&&state.final.rejected)throw Error('BUSINESS_REJECTED');
   }
   if(index===0&&!replay){
    const bound=await intake.capture();check?.();
    data??=readData();
    if(state)await this.files.remove(state.path);
    state={path:'notes/assets/.'+key+'.v1-'+(++this.serial)+'.part',sha256,count,intake:bound};
    entries.set(key,state);
   }else if(!state||state.sha256!==sha256||state.count!==count||state.final&&!replay){
    throw Error('AUTH_REVOKED');
   }
   intake=state.intake;part=state.path;
  }
  const commit=async(path:string,size:number,apply:(receipt?:ReturnType<typeof LocalBodyClaims.receipt>)=>Promise<void>)=>{
   check?.();
   if(!intake)return apply();
   const body={size,sha256,read:async(offset:number,length:number)=>{
    if(!this.files.readBytes)throw Error('LOCAL_IO');
    const chunk=await this.files.readBytes(path,offset,length);
    if(chunk.size!==size)throw Error('LOCAL_IO');
    return chunk.bytes;
   }};
   await intake({logicalId:key,cursor:digest(['syncNoteAsset',key,sha256,size]),body},apply);
  };
  const publish=async(path:string,size:number,apply:(receipt?:ReturnType<typeof LocalBodyClaims.receipt>)=>Promise<void>)=>{
   try{await commit(path,size,apply);}
   catch(error){
    if(state&&(error as Error).message==='BUSINESS_REJECTED'){
     const payload=data??(typeof request.data==='string'?request.data:undefined);
     if(payload!==undefined)state.final={dataHash:digest(payload),rejected:true};
     await this.files.remove(state.path).catch(()=>{});
    }
    if(state&&(error as Error).message==='AUTH_REVOKED')await this.files.remove(state.path).catch(()=>{});
    throw error;
   }
  };
  if((await this.files.stat(target)).file){
   const current=await this.files.hash(target);
   if(current.sha256.toLowerCase()===sha256){
    await publish(target,current.size,async()=>{});
    return result(true,true);
   }
  }
  if(!replay){
   if(index===0)await this.files.remove(part);
   else {const old=await this.files.stat(part);if(!old.file||old.size!==offset)throw new Error('备忘录图片分块顺序错误');}
  }
  data??=readData();
  const size=Math.floor(data.replace(/=+$/,'').length*6/8);if(size>CHUNK_BYTES)throw new Error('备忘录图片分块过大');
  // Each host write is below its 256 KiB limit; base64 boundaries encode 65535 bytes.
  let at=0,written=0;
  if(!replay)do{
   check?.();const piece=data.slice(at,at+87380),bytes=Math.floor(piece.replace(/=+$/,'').length*6/8);
   const value=index===0&&at===0?await this.files.write(part,piece):await this.files.append(part,piece,offset+written);
   written+=bytes;if(value.size!==offset+written)throw new Error('备忘录图片写入不完整');at+=piece.length;
  }while(at<data.length);
  if(complete){const actual=await this.files.hash(part);if(actual.sha256.toLowerCase()!==sha256)throw new Error('备忘录图片校验失败');
   await publish(part,actual.size,async receipt=>{
   check?.();
   if(state&&this.index){
    const previous=await this.index.version(key),current=previous?noteAssetVersionPath(key,previous.sha256):target;
    if((await this.files.stat(current)).file&&(await this.files.hash(current)).sha256!==sha256){
     check?.();await retainAssetConflict(this.files,part,key,sha256,actual.size,null);throw Error('note_asset_conflict');
    }
    const candidate=noteAssetVersionPath(key,sha256);
    check?.();await this.files.commit(part,candidate,actual.size,sha256,null);
    check?.();await this.index.commit(key,previous,actual,check,receipt);
    return;
   }
   try{await this.files.commit(part,target,actual.size,sha256,null);}catch(error){if(!String(error).includes('file_target_changed'))throw error;check?.();await retainAssetConflict(this.files,part,key,sha256,actual.size,null);throw Error('note_asset_conflict');}
  });
   if(state)state.final={dataHash:digest(data),rejected:false};
  }
  return result(complete);
 }
}
