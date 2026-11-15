import {retainAssetConflict} from './asset-conflict';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
export type NoteAssetHost=<T>(method:string,args:Record<string,unknown>)=>Promise<T>;
export const NOTE_IMAGE_LIMIT=5*1024*1024;
export const NOTE_ARCHIVE_LIMIT=32*1024*1024;
/** Read only stable complete assets; partial reads never become a publication. */
export function createNoteAssetReader(host:NoteAssetHost){return async(key:string,check:()=>void=()=>{})=>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key))throw Error('cloud_note_asset_path_invalid');
 check();const path='notes/assets/'+key,stat=await host<{file:boolean;size:number}>('file.stat',{path});
 if(!stat.file)throw Error('cloud_note_asset_missing');
 if(!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>NOTE_IMAGE_LIMIT)throw Error('cloud_note_asset_too_large');
 const hash=(await host<{sha256:string}>('file.hash',{path})).sha256,bytes=new Uint8Array(stat.size);
 for(let at=0;at<bytes.length;){check();const part=await host<{dataBase64:string;offset:number;size:number}>('file.read',{path,offset:at,maxBytes:Math.min(65536,bytes.length-at)}),raw=decodeBase64(part.dataBase64);
  if(part.offset!==at||part.size!==stat.size||raw.length!==Math.min(65536,bytes.length-at))throw Error('cloud_note_asset_read_incomplete');bytes.set(raw,at);at+=raw.length;
 }
 check();if(sha256Hex(bytes)!==hash||(await host<{sha256:string}>('file.hash',{path})).sha256!==hash)throw Error('cloud_note_asset_changed');return bytes;
};}
/** Local attachment references in Markdown links/images and HTML images/anchors. */
export function noteAssetKeys(markdown:string){
 const keys=new Set<string>();
 markdown.replace(/<(?:img|a)\b[^>]*\b(?:src|href)\s*=\s*(?:"assets\/([^"<>]+)"|'assets\/([^'<>]+)'|assets\/([^\s<>]+))[^>]*>|!?\[[^\]]*\]\(assets\/([^)]*)\)/gi,(_,a,b,c,d)=>{const key=a||b||c||d;if(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key))keys.add(key);return _;});
 return keys;
}
/** Run only after every readable head has merged. Omission of an archive is
 * never an instruction to delete another note's images. Re-read references
 * before each deletion; partial files and unrecognized names are not targets. */
export function createNoteAssetCollector(host:NoteAssetHost){return async(references:()=>Promise<ReadonlySet<string>>,check:()=>void)=>{
 check();const {entries}=await host<{entries:{file:boolean;path:string}[]}>('file.list',{path:'notes/assets'});let removed=0;
 for(const entry of entries){check();if(!entry.file||!entry.path.startsWith('notes/assets/'))continue;const key=entry.path.slice(13);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key)||/\.(?:part|pending|async-\d+|kv-migration)$/.test(key))continue;
  if((await references()).has(key))continue;check();const result=await host<{deleted:boolean}>('file.delete',{path:entry.path});
  if(!result.deleted&&(await host<{file:boolean}>('file.stat',{path:entry.path})).file)throw Error('cloud_note_asset_delete_incomplete');removed++;
 }return removed;
};}
/** Atomic target publication, using the same directory as local phone sync. */
export function createNoteAssetWriter(host:NoteAssetHost){return async(key:string,bytes:Uint8Array,expectedTargetSha256?:string|null)=>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key))throw Error('cloud_note_asset_path_invalid');
 const target='notes/assets/'+key,digest=sha256Hex(bytes),stat=await host<{file:boolean;size:number}>('file.stat',{path:target});
 if(expectedTargetSha256===undefined&&stat.file&&stat.size===bytes.length&&(await host<{sha256:string}>('file.hash',{path:target})).sha256===digest)return 0;
 const {path}=await host<{path:string}>('file.createTemp',{directory:'notes/assets'});
 try{for(let at=0;at<bytes.length;at+=65535){const part=bytes.subarray(at,at+65535),r=await host<{size:number}>('file.write',{path,dataBase64:encodeBase64(part),append:true,expectedOffset:at});if(r.size!==at+part.length)throw Error('cloud_note_asset_write_incomplete');}
  try{await host('file.commit',{path,target,expectedSize:bytes.length,expectedSha256:digest,expectedTargetSha256:expectedTargetSha256??null});}
  catch(error){if(!String(error).includes('file_target_changed'))throw error;
   await retainAssetConflict({hash:p=>host('file.hash',{path:p}),write:(p,dataBase64)=>host('file.write',{path:p,dataBase64,atomicReplace:true}),commit:(p,target,size,sha256,wanted)=>host('file.commit',{path:p,target,expectedSize:size,expectedSha256:sha256,expectedTargetSha256:wanted})},path,key,digest,bytes.length,expectedTargetSha256??null);
   throw Error('note_asset_conflict');
  }return 1;
 }finally{await host('file.delete',{path}).catch(()=>{});}
};}
